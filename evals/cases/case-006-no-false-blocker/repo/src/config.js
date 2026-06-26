// Configuration module
// Refactored: moved from single file to module structure

const config = {
  app: {
    name: "My App",
    version: "1.0.0",
  },
  server: {
    port: 3000,
    host: "localhost",
  },
  database: {
    url: "mongodb://localhost:27017/myapp",
  },
};

module.exports = config;
