import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { qrCodeRouter } from '../routes/productRoutes';

type Bindings = {
    DATABASE_URL: string;
    AES_SECRET_KEY: string;
};

const app = new Hono<{
    Bindings: Bindings;
}>();

app.use('/*', cors({
    origin: ['https://qr-code-frontend-rouge.vercel.app'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
}));

app.get('/', (c) => {
    return c.text('Hello from Cloudflare Workers with Hono!');
});

app.route('/api/products', qrCodeRouter);

export default {
    fetch: app.fetch,
} satisfies ExportedHandler<Bindings>;