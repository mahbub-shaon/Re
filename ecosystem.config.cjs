module.exports = {
  apps: [{
    name: 'undress-api',
    script: 'src/server.js',
    exec_mode: 'fork',
    instances: 1,
    max_memory_restart: '700M',
    restart_delay: 4000,
    exp_backoff_restart_delay: 150,
    kill_timeout: 35000,
    out_file: './logs/out.log',
    error_file: './logs/err.log',
    merge_logs: true,
    time: true,
    env: { NODE_ENV: 'production' },
  }],
};
