const fs = require("fs");
const path = require("path");
const winston = require("winston");
const DailyRotateFile = require("winston-daily-rotate-file");

const nodeEnv = String(process.env.NODE_ENV || "development").trim().toLowerCase();
const isProduction = nodeEnv === "production";
const isTest = nodeEnv === "test";
const logsDir = path.join(__dirname, "..", "..", "logs");

if (isProduction) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

const transports = [];

if (isProduction) {
  // Rotated files: errors and combined logs with compression/retention.
  transports.push(
    new DailyRotateFile({
      filename: path.join(logsDir, "error-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      zippedArchive: true,
      maxSize: "20m",
      maxFiles: "14d",
      level: "error",
      format: jsonFormat,
    }),
    new DailyRotateFile({
      filename: path.join(logsDir, "combined-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      zippedArchive: true,
      maxSize: "20m",
      maxFiles: "14d",
      level: "info",
      format: jsonFormat,
    })
  );
} else {
  transports.push(
    new winston.transports.Console({
      level: isTest ? "error" : "debug",
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.printf((info) => {
          const { level, message, timestamp, stack, ...rest } = info;
          const meta = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
          const line = stack ? `${message}\n${stack}` : message;
          return `${timestamp} [${level}]: ${line}${meta}`;
        })
      ),
    })
  );
}

const logger = winston.createLogger({
  level: isTest ? "error" : "info",
  transports,
});

module.exports = { logger };
