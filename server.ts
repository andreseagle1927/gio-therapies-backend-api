import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import dotenv from 'dotenv';
import multer from 'multer';

dotenv.config();

const upload = multer({ storage: multer.memoryStorage() });

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

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('CRITICAL: Supabase credentials missing in environment.');
  }

  const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '');

  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'gio-therapies-backend-api' });
  });

  app.post('/api/bookings', async (req, res) => {
    try {
      const { data, error } = await supabase.from('bookings').insert([req.body]).select().single();

      if (error) throw error;
      res.json({ success: true, id: data.id });
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
      const { data, error } = await supabase.from('bookings').select('*').order('date', { ascending: false });

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
      const { status } = req.body;
      const { id } = req.params;

      const { data: booking, error: updateError } = await supabase
        .from('bookings')
        .update({ status })
        .eq('id', id)
        .select()
        .single();

      if (updateError) throw updateError;

      if (status === 'confirmed') {
        if (!process.env.RESEND_API_KEY) {
          console.warn('Skipping email: RESEND_API_KEY is not set in environment variables.');
        } else {
          const resend = new Resend(process.env.RESEND_API_KEY);
          await resend.emails.send({
            from: 'Ritual Sanctuary <onboarding@resend.dev>',
            to: [booking.email],
            subject: 'Your Ritual Appointment is Confirmed 🌿',
            html: `
              <div style="font-family: sans-serif; color: #334155; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 40px; border: 1px solid #f1f5f9; border-radius: 24px;">
                <h2 style="color: #92754d; font-weight: 300; font-size: 28px;">Ritual Confirmation</h2>
                <p>Hello ${booking.name},</p>
                <p>Your request for the <strong>${booking.service_title}</strong> has been confirmed by the sanctuary.</p>
                <div style="background-color: #fcfaf7; padding: 24px; border-radius: 16px; margin: 30px 0; border: 1px solid #92754d20;">
                  <h4 style="margin: 0 0 10px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 2px; color: #92754d;">Appointment Details</h4>
                  <p style="margin: 5px 0;"><strong>Date:</strong> ${new Date(booking.date).toLocaleDateString()}</p>
                  <p style="margin: 5px 0;"><strong>Time:</strong> ${booking.time}</p>
                  <p style="margin: 5px 0;"><strong>Location:</strong> Gio Therapies Sanctuary</p>
                </div>
              </div>
            `,
          });
        }
      }

      res.json({ success: true });
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
      const { data, error } = await supabase.from('services').select('*').order('sort_order', { ascending: true });

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
