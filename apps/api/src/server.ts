import { buildApp } from './app';

const app = await buildApp();
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
console.log(`API escuchando en http://localhost:${port}`);
