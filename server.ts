import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import dotenv from 'dotenv';
import multer from 'multer';

dotenv.config();

const upload = multer({ storage: multer.memoryStorage() });

type EmailResult = {
  sent: boolean;
  id?: string;
  error?: string;
};

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatBookingDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString('en-GB', {
        timeZone: 'UTC',
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = Array.isArray(value) || (typeof value === 'object' && value !== null)
    ? JSON.stringify(value)
    : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function createBookingCsv(booking: Record<string, unknown>, intake: Record<string, unknown>): string {
  const rows: Array<[string, unknown]> = [['Field', 'Value']];
  Object.entries(booking).forEach(([key, value]) => rows.push([key, value]));
  Object.entries(intake).forEach(([key, value]) => rows.push([`intake.${key}`, value]));
  return rows.map(([key, value]) => `${csvCell(key)},${csvCell(value)}`).join('\r\n');
}

function consultationSummary(intake: Record<string, unknown>): string {
  return Object.entries(intake)
    .filter(([key]) => !key.startsWith('consent_to_'))
    .map(([key, value]) => {
      const formatted = Array.isArray(value)
        ? value.map((item) => typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item)).join(', ')
        : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
      return formatted ? `${key}: ${formatted}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function bookingDetailsHtml(booking: Record<string, any>): string {
  return `
    <div style="background:#fcfaf7;padding:20px;border-radius:16px;border:1px solid #eadfce;line-height:1.7">
      <p style="margin:0"><strong>Service:</strong> ${escapeHtml(booking.service_title)}</p>
      <p style="margin:0"><strong>Date:</strong> ${escapeHtml(formatBookingDate(booking.date))}</p>
      <p style="margin:0"><strong>Time:</strong> ${escapeHtml(booking.time)}</p>
      <p style="margin:0"><strong>Name:</strong> ${escapeHtml(booking.name)}</p>
      <p style="margin:0"><strong>Email:</strong> ${escapeHtml(booking.email)}</p>
      <p style="margin:0"><strong>Phone:</strong> ${escapeHtml(booking.phone)}</p>
      ${booking.notes ? `<p style="margin:12px 0 0"><strong>Notes:</strong><br>${escapeHtml(booking.notes).replace(/\n/g, '<br>')}</p>` : ''}
    </div>`;
}

async function sendBookingEmail(
  resend: Resend | null,
  from: string,
  to: string | undefined,
  subject: string,
  html: string,
  replyTo?: string,
  attachments?: Array<{ filename: string; content: string }>,
): Promise<EmailResult> {
  if (!to) return { sent: false, error: 'Recipient email is not configured.' };
  if (!resend || !from) return { sent: false, error: 'Email service is not configured.' };

  try {
    const result = await resend.emails.send({
      from,
      to: [to],
      subject,
      html,
      ...(replyTo ? { replyTo } : {}),
      ...(attachments?.length ? { attachments } : {}),
    });

    if (result.error) {
      console.error('Resend rejected booking email:', result.error);
      return { sent: false, error: 'Email provider rejected the message.' };
    }

    return { sent: true, id: result.data?.id };
  } catch (error: any) {
    console.error('Booking email delivery failed:', error?.message || error);
    return { sent: false, error: 'Email delivery failed.' };
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3001);

  const supabaseUrl =
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey =
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const hasSupabaseConfig = Boolean(supabaseUrl && supabaseAnonKey);
  const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
  const emailFrom = process.env.RESEND_FROM_EMAIL || '';
  const environmentBookingNotificationEmail = process.env.BOOKING_NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL;

  if (!hasSupabaseConfig) {
    console.error('CRITICAL: Supabase credentials missing in environment.');
  }

  const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '');

  async function requireAdminSession(req: express.Request, res: express.Response): Promise<boolean> {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      res.status(401).json({ error: 'Admin authentication is required.' });
      return false;
    }
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      res.status(401).json({ error: 'Admin authentication is invalid or expired.' });
      return false;
    }
    return true;
  }

  async function getBookingNotificationEmail(): Promise<string> {
    try {
      const { data, error } = await supabase
        .from('settings')
        .select('value')
        .eq('key', 'booking_notification_email')
        .maybeSingle();
      if (!error && String(data?.value || '').trim()) return String(data?.value).trim();
    } catch (error) {
      console.warn('Could not read saved booking notification email.', error);
    }
    return String(environmentBookingNotificationEmail || '').trim();
  }

  app.use(cors({
    origin: (origin, callback) => {
      const allowedOrigins = new Set([
        'https://giotherapies.uk',
        'https://www.giotherapies.uk',
        'http://localhost:3000',
        'http://localhost:3100',
      ]);
      callback(null, !origin || allowedOrigins.has(origin));
    },
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use(express.json());

  app.use('/api', (_req, res, next) => {
    if (!hasSupabaseConfig) {
      return res.status(503).json({
        error: 'Backend is missing SUPABASE_URL or SUPABASE_ANON_KEY',
      });
    }

    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'gio-therapies-backend-api' });
  });

  app.post('/api/bookings', async (req, res) => {
    try {
      const body = req.body || {};
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const phone = String(body.phone || '').trim();
      const date = String(body.date || '').trim();
      const time = String(body.time || '').trim();
      const serviceId = String(body.service_id || '').trim();
      const serviceTitle = String(body.service_title || '').trim();
      const category = String(body.category || '').trim();
      const notes = String(body.notes || '').trim().slice(0, 2000);
      const intake = body.intake && typeof body.intake === 'object' ? body.intake as Record<string, unknown> : {};
      const intakeText = consultationSummary(intake);
      const storedNotes = [notes, intakeText ? `CONSULTATION INTAKE\n${intakeText}` : ''].filter(Boolean).join('\n\n').slice(0, 10000);

      if (!name || !email || !phone || !date || !time || !serviceId || !serviceTitle) {
        return res.status(400).json({ success: false, error: 'Please provide all required booking details.' });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ success: false, error: 'Please provide a valid email address.' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
        return res.status(400).json({ success: false, error: 'Please provide a valid preferred date and time.' });
      }

      const bookingPayload = {
        service_id: serviceId,
        service_title: serviceTitle,
        name,
        email,
        phone,
        date,
        time,
        notes: storedNotes,
        category,
        status: 'pending',
        created_at: new Date().toISOString(),
      };

      const { data, error } = await supabase.from('bookings').insert([bookingPayload]).select().single();

      if (error) throw error;
      if (!data) throw new Error('Booking was not returned after insert.');

      const bookingHtml = bookingDetailsHtml(data);
      const notificationEmail = await getBookingNotificationEmail();
      const spreadsheet = createBookingCsv(data, intake);
      void Promise.all([
        sendBookingEmail(
          resend,
          emailFrom,
          notificationEmail,
          `New booking request — ${name}`,
          `<div style="font-family:Arial,sans-serif;color:#334155;max-width:640px;margin:auto"><h2>New Gio Therapies booking request</h2>${bookingHtml}<p style="margin-top:20px">Review and confirm this request in the admin panel.</p></div>`,
          email,
          [{
            filename: `gio-booking-${date}.csv`,
            content: Buffer.from(spreadsheet, 'utf8').toString('base64'),
          }],
        ),
        sendBookingEmail(
          resend,
          emailFrom,
          email,
          'We received your Gio Therapies request',
          `<div style="font-family:Arial,sans-serif;color:#334155;max-width:640px;margin:auto"><h2>Request received</h2><p>Hello ${escapeHtml(name)},</p><p>We have received your request and will contact you personally to confirm availability.</p>${bookingHtml}<p style="margin-top:20px;color:#64748b">This is not yet a confirmed appointment.</p></div>`,
        ),
      ]).then(([internalEmail, customerEmail]) => {
        console.log('Booking email results:', {
          bookingId: data.id,
          internalSent: internalEmail.sent,
          customerSent: customerEmail.sent,
        });
      });

      res.status(201).json({
        success: true,
        id: data.id,
        email: {
          configured: Boolean(resend && emailFrom && notificationEmail),
          queued: true,
        },
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message,
        details: error.details || error.hint || 'No additional details provided',
      });
    }
  });

  app.get('/api/bookings', async (_req, res) => {
    try {
      let { data, error } = await supabase.from('bookings').select('*').order('date', { ascending: false });

      if (error && error.code === '42703') {
        const fallback = await supabase.from('bookings').select('*');
        data = fallback.data;
        error = fallback.error;
      }

      if (error) {
        if (error.code === '42P01') return res.json([]);
        throw error;
      }
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch('/api/bookings/:id', async (req, res) => {
    try {
      const status = String(req.body?.status || '').toLowerCase();
      const { id } = req.params;

      if (!['pending', 'confirmed', 'cancelled'].includes(status)) {
        return res.status(400).json({ error: 'Unsupported booking status.' });
      }

      const { data: existingBooking, error: fetchError } = await supabase
        .from('bookings')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (fetchError) throw fetchError;
      if (!existingBooking) return res.status(404).json({ error: 'Booking not found.' });

      if (existingBooking.status === status) {
        return res.json({ success: true, alreadyApplied: true, email: { sent: false, skipped: true } });
      }

      const { data: booking, error: updateError } = await supabase
        .from('bookings')
        .update({ status })
        .eq('id', id)
        .select()
        .single();

      if (updateError) throw updateError;

      let email: EmailResult = { sent: false, error: 'No status email required.' };
      if (status === 'confirmed') {
        email = await sendBookingEmail(
          resend,
          emailFrom,
          booking.email,
          'Your Gio Therapies appointment is confirmed',
          `<div style="font-family:Arial,sans-serif;color:#334155;max-width:640px;margin:auto"><h2>Your appointment is confirmed</h2><p>Hello ${escapeHtml(booking.name)},</p><p>Your Gio Therapies request has been confirmed.</p>${bookingDetailsHtml(booking)}<p style="margin-top:20px;color:#64748b">If you need to reschedule, please reply to this email as soon as possible.</p></div>`,
        );
      } else if (status === 'cancelled') {
        email = await sendBookingEmail(
          resend,
          emailFrom,
          booking.email,
          'Update on your Gio Therapies request',
          `<div style="font-family:Arial,sans-serif;color:#334155;max-width:640px;margin:auto"><h2>Update on your request</h2><p>Hello ${escapeHtml(booking.name)},</p><p>Unfortunately, we are unable to confirm this request at the preferred time. Please reply to this email if you would like to discuss another option.</p>${bookingDetailsHtml(booking)}</div>`,
        );
      }

      res.json({ success: true, email });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete('/api/bookings/:id', async (req, res) => {
    try {
      const { error } = await supabase.from('bookings').delete().eq('id', req.params.id);

      if (error) throw error;
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/services', async (_req, res) => {
    try {
      let { data, error } = await supabase.from('services').select('*').order('sort_order', { ascending: true });

      if (error && error.code === '42703') {
        const fallback = await supabase.from('services').select('*');
        data = fallback.data;
        error = fallback.error;
      }

      if (error) {
        if (error.code === '42P01') return res.json([]);
        return res.status(500).json({ error: error.message, hint: 'Ensure the "services" table exists.' });
      }

      const transformed = (data || []).map((service: any) => {
        if (service.image_url && service.image_url.includes('/storage/v1/object/public/')) {
          const parts = service.image_url.split('/storage/v1/object/public/');
          return {
            ...service,
            image_url: `/api/media/${parts[1]}`,
          };
        }
        return service;
      });

      res.json(transformed);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/services', async (req, res) => {
    try {
      const { data, error } = await supabase.from('services').upsert([req.body]).select().single();

      if (error) throw error;
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete('/api/services/:id', async (req, res) => {
    try {
      const { error } = await supabase.from('services').delete().eq('id', req.params.id);

      if (error) throw error;
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/settings', async (_req, res) => {
    try {
      const { data, error } = await supabase.from('settings').select('*');

      if (error) {
        if (error.code === '42P01') return res.json({});
        return res.status(500).json({ error: error.message, hint: 'Ensure the "settings" table exists.' });
      }

      const settingsMap = (data || []).reduce((acc: any, curr: any) => {
        let val = curr.value;
        if (typeof val === 'string' && val.includes('/storage/v1/object/public/')) {
          const parts = val.split('/storage/v1/object/public/');
          if (parts.length > 1) {
            val = `/api/media/${parts[1]}`;
          }
        }
        acc[curr.key] = val;
        return acc;
      }, {});

      res.json(settingsMap);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/settings', async (req, res) => {
    try {
      const { key, value } = req.body;
      const { data, error } = await supabase.from('settings').upsert([{ key, value }]).select().single();

      if (error) throw error;
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/notification-settings', async (req, res) => {
    try {
      if (!await requireAdminSession(req, res)) return;
      const { data, error } = await supabase
        .from('settings')
        .select('value')
        .eq('key', 'booking_notification_email')
        .maybeSingle();
      if (error) throw error;
      res.json({ email: data?.value || environmentBookingNotificationEmail || '' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/notification-settings', async (req, res) => {
    try {
      if (!await requireAdminSession(req, res)) return;
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Enter a valid notification email address.' });
      }
      const { error } = await supabase
        .from('settings')
        .upsert([{ key: 'booking_notification_email', value: email }], { onConflict: 'key' });
      if (error) throw error;
      res.json({ success: true, email });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/notification-settings/test', async (req, res) => {
    try {
      if (!await requireAdminSession(req, res)) return;
      const notificationEmail = await getBookingNotificationEmail();
      const result = await sendBookingEmail(
        resend,
        emailFrom,
        notificationEmail,
        'Gio Therapies notification test',
        '<div style="font-family:Arial,sans-serif;color:#334155;max-width:640px;margin:auto"><h2>Gio Therapies email connection test</h2><p>This is a test message from the admin notification settings.</p><p>New booking requests will be sent to this recipient with their consultation details attached.</p></div>',
      );
      if (!result.sent) return res.status(502).json({ error: result.error || 'The test email could not be sent.' });
      res.json({ success: true, sent: true, email: notificationEmail, id: result.id });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'The test email could not be sent.' });
    }
  });

  const defaultReviews = [
    {
      id: 'default-review-1',
      name: 'Emily R.',
      quote:
        'I walked in with shoulder pain and left feeling light, aligned, and deeply relaxed. The treatment was professional and truly tailored to me.',
      location: 'London',
      rating: 5,
    },
    {
      id: 'default-review-2',
      name: 'James T.',
      quote:
        'Best sports massage I have had in years. Recovery after training is much faster and the tension in my lower back is finally under control.',
      location: 'Canary Wharf',
      rating: 5,
    },
    {
      id: 'default-review-3',
      name: 'Sofia M.',
      quote:
        'Calm environment, excellent communication, and results from the first session. I now book monthly as part of my routine.',
      location: 'Shoreditch',
      rating: 5,
    },
  ];

  const sanitizeReviews = (input: any): any[] => {
    if (!Array.isArray(input)) return [];

    return input
      .map((item: any, index: number) => {
        const rating = Math.max(1, Math.min(5, Number(item?.rating) || 5));
        return {
          id: String(item?.id || `review-${Date.now()}-${index}`),
          name: String(item?.name || '').trim(),
          quote: String(item?.quote || '').trim(),
          location: String(item?.location || '').trim(),
          rating,
        };
      })
      .filter((item) => item.name && item.quote);
  };

  app.get('/api/reviews', async (_req, res) => {
    try {
      const { data, error } = await supabase.from('settings').select('value').eq('key', 'home_reviews').maybeSingle();

      if (error) {
        if (error.code === '42P01') return res.json(defaultReviews);
        throw error;
      }

      if (!data?.value) return res.json(defaultReviews);

      let parsed = data.value;
      if (typeof parsed === 'string') {
        try {
          parsed = JSON.parse(parsed);
        } catch {
          parsed = [];
        }
      }

      const reviews = sanitizeReviews(parsed);
      res.json(reviews.length > 0 ? reviews : defaultReviews);
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to load reviews.' });
    }
  });

  app.post('/api/reviews', async (req, res) => {
    try {
      const reviews = sanitizeReviews(req.body?.reviews);

      const { error } = await supabase
        .from('settings')
        .upsert([{ key: 'home_reviews', value: JSON.stringify(reviews) }]);

      if (error) throw error;
      res.json(reviews);
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to save reviews.' });
    }
  });

  app.get('/api/about', async (_req, res) => {
    try {
      const { data: headerImageSetting } = await supabase
        .from('settings')
        .select('value')
        .eq('key', 'about_header_image_url')
        .maybeSingle();

      const { data, error } = await supabase.from('about_content').select('*').maybeSingle();

      if (error) {
        if (error.code === '42P01') {
          return res.json({
            title: 'About Me',
            description: '',
            diplomas: [],
            header_image_url: headerImageSetting?.value || null,
          });
        }
        throw error;
      }

      if (!data) {
        return res.json({
          title: 'About Me',
          description: '',
          diplomas: [],
          header_image_url: headerImageSetting?.value || null,
        });
      }

      res.json({
        ...data,
        header_image_url: headerImageSetting?.value || data?.header_image_url || null,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  app.post('/api/about', async (req, res) => {
    try {
      const { header_image_url, ...aboutPayload } = req.body || {};
      const payload = { ...aboutPayload, id: 1 };

      if (typeof header_image_url === 'string') {
        await supabase.from('settings').upsert([{ key: 'about_header_image_url', value: header_image_url }]);
      }

      const { data, error } = await supabase.from('about_content').upsert([payload]).select().maybeSingle();

      if (error) throw error;
      res.json({ ...data, header_image_url: header_image_url || null });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  app.get('/api/footer', async (_req, res) => {
    try {
      const { data, error } = await supabase.from('footer_settings').select('*').maybeSingle();

      if (error && error.code !== '42P01') throw error;

      if (!data || error?.code === '42P01') {
        return res.json({
          address: 'London Therapy Studio\nAddress provided upon confirmation',
          hours: 'Mon — Fri: 08:30 - 20:00\nSat: 09:00 - 17:00\nSun: Meditation',
          instagram_url: '#',
          linkedin_url: '#',
          copyright: `© ${new Date().getFullYear()} Gio Therapies • Handcrafted for Your Wellbeing • London`,
          partner_logos: [],
        });
      }

      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  app.post('/api/footer', async (req, res) => {
    try {
      const payload = { ...req.body, id: 1 };
      const { data, error } = await supabase.from('footer_settings').upsert([payload]).select().maybeSingle();

      if (error) throw error;
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const fileExt = req.file.originalname.split('.').pop();
      const fileName = `${Math.random().toString(36).substring(2)}-${Date.now()}.${fileExt}`;
      const filePath = `services/${fileName}`;

      const { error: uploadError } = await supabase.storage.from('gioterapy').upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

      if (uploadError) throw uploadError;

      const proxiedUrl = `/api/media/gioterapy/${filePath}`;
      res.json({ publicUrl: proxiedUrl });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/media/:bucket/:path(*)', async (req, res) => {
    try {
      const { bucket, path: filePath } = req.params;

      const { data, error } = await supabase.storage.from(bucket).download(filePath);
      if (error) throw error;

      const buffer = Buffer.from(await data.arrayBuffer());
      res.setHeader('Cache-Control', 'public, max-age=31104000');
      res.setHeader('Content-Type', data.type || 'image/jpeg');
      res.send(buffer);
    } catch (_error: any) {
      res.status(404).send('Not Found');
    }
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend API running on http://localhost:${PORT}`);
  });
}

startServer();
