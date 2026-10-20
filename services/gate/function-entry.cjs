// The archive exposes this CommonJS file as index.js for the index.handler entrypoint.
const runtime = import('./services/gate/src/function.mjs');
exports.handler = async (event) => (await runtime).handler(event);
