require('dotenv').config();
const { Sequelize } = require('sequelize');

const config = {
  development: {
    username: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : 'root',
    database: process.env.DB_NAME || 'streamvault',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 4000,
    dialect: 'mysql',
    logging: false,
    pool: {
      max: 10,
      min: 0,
      acquire: 30000,
      idle: 10000,
    },
    define: {
      underscored: true,
      timestamps: true,
    },
  },
  test: {
    username: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || null,
    database: process.env.DB_NAME_TEST || 'streamvault_test',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    dialect: 'mysql',
    logging: false,
    define: {
      underscored: true,
      timestamps: true,
    },
  },
  production: {
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    dialect: 'mysql',
    logging: false,
    pool: {
      max: 20,
      min: 5,
      acquire: 60000,
      idle: 10000,
    },
    define: {
      underscored: true,
      timestamps: true,
    },
  },
};

const env = process.env.NODE_ENV || 'development';

// Enable secure connections for TiDB Cloud serverless or when requested via DB_SSL env var
for (const key in config) {
  if (config[key].host && (config[key].host.includes('tidbcloud.com') || process.env.DB_SSL === 'true')) {
    config[key].dialectOptions = {
      ssl: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
      },
    };
  }
}

const dbConfig = config[env];
console.log('dbConfig: ', dbConfig);

const sequelize = new Sequelize(
  dbConfig.database,
  dbConfig.username,
  dbConfig.password,
  dbConfig
);

module.exports = config;
module.exports.sequelize = sequelize;
module.exports.Sequelize = Sequelize;
