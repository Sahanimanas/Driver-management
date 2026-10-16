// pm2 config for the Driver Management app.
//   pm2 start ecosystem.config.cjs   (first time)
//   pm2 restart driver-mgmt-api driver-mgmt-web --update-env
//
// The web app is served by `vite preview` out of web/dist, so the "start"
// script rebuilds before serving — that is what makes a plain pm2 restart
// pick up frontend source changes.
module.exports = {
  apps: [
    {
      name: 'driver-mgmt-api',
      cwd: '/root/Driver-management/server',
      script: 'src/index.js',
      interpreter: 'node',
      interpreter_args: '--no-warnings',
      exec_mode: 'fork',
      autorestart: true,
    },
    {
      name: 'driver-mgmt-web',
      cwd: '/root/Driver-management/web',
      script: 'npm',
      args: 'run start',
      exec_mode: 'fork',
      autorestart: true,
      // a failing build must not turn into a restart loop
      min_uptime: '20s',
      max_restarts: 5,
    },
  ],
};
