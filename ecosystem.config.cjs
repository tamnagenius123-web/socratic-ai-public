// Optional PM2 entry for the same disconnected loopback-only local demo.
// Build with npm run build first; PM2 is not installed or invoked by this project.
module.exports = {
  apps: [{
    name: 'socratic-ai-local-demo',
    cwd: __dirname,
    script: './scripts/local-demo.mjs',
    interpreter: 'node',
    args: '--port=8787',
    watch: false,
    instances: 1,
    exec_mode: 'fork'
  }]
};
