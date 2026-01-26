/**
 * Express middleware for Chalk webhooks
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/webhooks
 */

import type { Request, Response, NextFunction } from "express";
import {
  createWebhookHandler,
  type WebhookHandlerOptions,
  type WebhookEvent,
} from "./handler";

declare global {
  namespace Express {
    interface Request {
      chalkEvent?: WebhookEvent;
    }
  }
}

/**
 * Express middleware for verifying and parsing Chalk webhooks
 *
 * @example
 * ```ts
 * import express from 'express';
 * import { chalkWebhookMiddleware } from '@q9labs/chalk-core';
 *
 * const app = express();
 *
 * app.post(
 *   '/webhooks/chalk',
 *   express.raw({ type: 'application/json' }),
 *   chalkWebhookMiddleware({ secret: process.env.CHALK_WEBHOOK_SECRET }),
 *   (req, res) => {
 *     const { meeting, transcript } = req.chalkEvent.payload;
 *     // Process the webhook...
 *     res.sendStatus(200);
 *   }
 * );
 * ```
 */
export function chalkWebhookMiddleware(options: WebhookHandlerOptions) {
  const handler = createWebhookHandler(options);

  return (req: Request, res: Response, next: NextFunction) => {
    const signature = req.headers["x-chalk-signature"];
    const timestamp = req.headers["x-chalk-timestamp"];

    if (typeof signature !== "string" || typeof timestamp !== "string") {
      res.status(401).json({ error: "Missing webhook headers" });
      return;
    }

    // Handle both raw buffer and parsed body
    let body: string;
    if (Buffer.isBuffer(req.body)) {
      body = req.body.toString("utf8");
    } else if (typeof req.body === "string") {
      body = req.body;
    } else {
      body = JSON.stringify(req.body);
    }

    handler
      .verify(body, signature, timestamp)
      .then((event) => {
        req.chalkEvent = event;
        next();
      })
      .catch(() => {
        res.status(401).json({ error: "Webhook verification failed" });
      });
  };
}
