import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { qrCodeRouter } from '../routes/productRoutes';

// Define the type for environment bindings
type Bindings = {
    DATABASE_URL: string;
    AES_SECRET_KEY: string;
};

// Create the Hono app with proper type bindings
const app = new Hono<{
    Bindings: Bindings;
}>();

// Configure CORS
app.use('/*', cors({
    origin: 'https://qr-code-frontend-rouge.vercel.app',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowHeaders: ['Content-Type', 'Authorization'],
}));

// Root route
app.get('/', (c) => {
    return c.text('Hello from Cloudflare Workers with Hono! Typescript Enabled!');
});

// Mount the QR code routes
app.route('/api/products', qrCodeRouter);

// Export the worker with the Hono app
export default {
    fetch: app.fetch,
} satisfies ExportedHandler<Bindings>;