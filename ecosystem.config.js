module.exports = {
  apps: [
    {
      name: "kh-agriconnect",
      script: "src/server.js",
      instances: "max",
      exec_mode: "cluster",
      watch: false,
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
