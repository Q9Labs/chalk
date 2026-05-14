/**
 * Express middleware for Chalk webhooks
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/webhooks
 */

import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import { ChalkError, ChalkErrorCode } from "../errors/chalk-error";
import { createWebhookHandler, type WebhookEvent, type WebhookHandlerOptions } from "./handler";

declare global {
  namespace Express {
    interface Request {
      chalkDeliveryId?: string;
      chalkEvent?: WebhookEvent;
      chalkHeaderEventType?: string;
      chalkTimestampHeader?: string;
      chalkWebhookBodySha256?: string;
    }
  }
}

const DEFAULT_PARSER_PATH = "/webhook/chalk";

export interface ChalkWebhookExpressOptions extends WebhookHandlerOptions {
  /**
   * Require `application/json` content type before verification.
   * Defaults to `true`.
   */
  requireJsonContentType?: boolean;
}

export interface ChalkWebhookParserErrorOptions {
  /**
   * Restrict JSON parser error handling to a specific route path.
   * Defaults to `/webhook/chalk`.
   */
  path?: string;
}

type WebhookErrorResponse = {
  statusCode: number;
  body: {
    error: string;
    errorCode: string;
    retryable: boolean;
  };
};

type ChalkErrorDetails = {
  code?: string;
  message?: string;
  recoverable?: boolean;
};

export function normalizeChalkSignatureHeader(signature: string) {
  const trimmed = signature.trim();
  if (trimmed.startsWith("sha256=")) return trimmed;
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return `sha256=${trimmed}`;
  return trimmed;
}

async function sha256Hex(input: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function extractBody(req: Request) {
  if (Buffer.isBuffer(req.body)) {
    return req.body.toString("utf8");
  }
  if (typeof req.body === "string") {
    return req.body;
  }
  return null;
}

function extractChalkErrorDetails(error: unknown): ChalkErrorDetails {
  if (error instanceof ChalkError) {
    return {
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
    };
  }

  if (typeof error === "object" && error !== null) {
    const maybeToJSON = (error as { toJSON?: () => unknown }).toJSON;
    if (typeof maybeToJSON === "function") {
      try {
        const json = maybeToJSON.call(error) as {
          cause?: {
            failure?: {
              code?: unknown;
              message?: unknown;
              recoverable?: unknown;
            };
          };
        };
        const failure = json.cause?.failure;
        const wrappedMessage =
          error instanceof Error
            ? error.message.replace(/^\(FiberFailure\)\s+ChalkError:\s*/, "")
            : undefined;
        const details = {
          code: typeof failure?.code === "string" ? failure.code : undefined,
          message:
            typeof failure?.message === "string" && failure.message.length > 0
              ? failure.message
              : wrappedMessage,
          recoverable:
            typeof failure?.recoverable === "boolean"
              ? failure.recoverable
              : undefined,
        };
        if (
          typeof details.code === "string" ||
          typeof details.message === "string" ||
          typeof details.recoverable === "boolean"
        ) {
          return details;
        }
      } catch {
        // ignore malformed wrapper failures and fall through to generic handling
      }
    }
  }

  if (error instanceof Error) {
    return { message: error.message };
  }

  return {};
}

function mapVerificationError(error: unknown): WebhookErrorResponse {
  const details = extractChalkErrorDetails(error);
  const errorMessage = details.message ?? "Webhook verification failed unexpectedly";

  switch (details.code) {
    case ChalkErrorCode.WEBHOOK_SIGNATURE_INVALID:
    case ChalkErrorCode.WEBHOOK_TIMESTAMP_EXPIRED:
      return {
        statusCode: 401,
        body: {
          error: errorMessage,
          errorCode: details.code,
          retryable: false,
        },
      };
    case ChalkErrorCode.WEBHOOK_PAYLOAD_INVALID:
      return {
        statusCode: 400,
        body: {
          error: errorMessage,
          errorCode: details.code,
          retryable: false,
        },
      };
    default:
      return {
        statusCode: 500,
        body: {
          error: errorMessage,
          errorCode: details.code ?? "WEBHOOK_VERIFICATION_FAILED",
          retryable: details.recoverable ?? true,
        },
      };
  }
}

function requestPath(req: Request) {
  if (typeof req.path === "string" && req.path.length > 0) return req.path;
  if (typeof req.originalUrl === "string" && req.originalUrl.length > 0) {
    return req.originalUrl.split("?")[0] ?? req.originalUrl;
  }
  return "";
}

/**
 * Express middleware for verifying and parsing Chalk webhooks
 *
 * @example
 * ```ts
 * import express from "express";
 * import {
 *   chalkWebhookMiddleware,
 *   chalkWebhookParserErrorMiddleware,
 * } from "@q9labs/chalk-core";
 *
 * const app = express();
 *
 * app.use(
 *   "/webhooks/chalk",
 *   express.raw({ type: "application/json", limit: "5mb" }),
 *   chalkWebhookMiddleware({ secret: process.env.CHALK_WEBHOOK_SECRET! }),
 *   (req, res) => {
 *     const { meeting, transcript } = req.chalkEvent!.payload;
 *     res.sendStatus(200);
 *   },
 * );
 *
 * app.use(chalkWebhookParserErrorMiddleware({ path: "/webhooks/chalk" }));
 * ```
 */
export function chalkWebhookMiddleware(options: ChalkWebhookExpressOptions) {
  const handler = createWebhookHandler(options);
  const requireJsonContentType = options.requireJsonContentType ?? true;

  return async (req: Request, res: Response, next: NextFunction) => {
    const signature = req.headers["x-chalk-signature"];
    const timestamp = req.headers["x-chalk-timestamp"];
    const deliveryId = req.headers["x-chalk-delivery-id"];
    const headerEventType = req.headers["x-chalk-event"];

    req.chalkDeliveryId =
      typeof deliveryId === "string" && deliveryId.trim().length > 0
        ? deliveryId.trim()
        : undefined;
    req.chalkHeaderEventType =
      typeof headerEventType === "string" && headerEventType.trim().length > 0
        ? headerEventType.trim()
        : undefined;
    req.chalkTimestampHeader = typeof timestamp === "string" ? timestamp : undefined;

    if (requireJsonContentType && !req.is("application/json")) {
      res.status(415).json({
        error: "Webhook content type must be application/json",
        errorCode: "WEBHOOK_CONTENT_TYPE_INVALID",
        retryable: false,
      });
      return;
    }

    if (typeof signature !== "string" || typeof timestamp !== "string") {
      res.status(401).json({
        error: "Missing webhook headers",
        errorCode: "WEBHOOK_HEADERS_MISSING",
        retryable: false,
      });
      return;
    }

    const body = extractBody(req);
    if (typeof body !== "string") {
      res.status(400).json({
        error: "Webhook body missing",
        errorCode: "WEBHOOK_BODY_MISSING",
        retryable: false,
      });
      return;
    }

    req.chalkWebhookBodySha256 = await sha256Hex(body);

    try {
      const event = await handler.verify(
        body,
        normalizeChalkSignatureHeader(signature),
        timestamp,
      );
      req.chalkEvent = event;
      next();
    } catch (error) {
      const response = mapVerificationError(error);
      res.status(response.statusCode).json(response.body);
    }
  };
}

export function chalkWebhookParserErrorMiddleware(
  options: ChalkWebhookParserErrorOptions = {},
): ErrorRequestHandler {
  const path = options.path ?? DEFAULT_PARSER_PATH;

  return (err, req, res, next) => {
    if (requestPath(req) !== path) {
      next(err);
      return;
    }

    const statusCode = err?.type === "entity.too.large" ? 413 : 400;
    const errorCode =
      err?.type === "entity.too.large"
        ? "WEBHOOK_BODY_TOO_LARGE"
        : "WEBHOOK_BODY_PARSE_FAILED";
    const errorMessage =
      err?.type === "entity.too.large"
        ? "Webhook payload exceeded configured size limit"
        : "Webhook body could not be parsed";

    res.status(statusCode).json({
      error: errorMessage,
      errorCode,
      retryable: false,
    });
  };
}
