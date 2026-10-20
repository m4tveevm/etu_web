import { createServer } from 'node:http';
import { readConfig } from './config.mjs';
import { createOidc } from './oidc.mjs';
import { createCloud } from './cloud.mjs';
import { createApp } from './app.mjs';

const config = readConfig(process.env);
const audit = (event) => process.stdout.write(`${JSON.stringify({ event })}\n`);
if (!config) audit('configuration_invalid');
const server = createServer({ maxHeaderSize: 16_384, requestTimeout: 20_000, headersTimeout: 10_000 }, createApp({
  config, oidc: config && createOidc(config), cloud: config && createCloud(config), audit,
}));
server.keepAliveTimeout = 5000;
server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
