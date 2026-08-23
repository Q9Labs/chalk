/* Generated from contract/generated/openapi.json. Do not edit by hand. */
globalThis.CHALK_API_DESIGN_OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "Chalk API contract preview",
    version: "0.0.0-preview",
    license: {
      name: "Apache-2.0",
      identifier: "Apache-2.0",
    },
  },
  servers: [
    {
      url: "https://api.chalkmeet.com",
      description: "Production API",
    },
  ],
  paths: {
    "/v1/auth/google/callback": {
      get: {
        operationId: "completeGoogleSignIn",
        parameters: [
          {
            in: "query",
            name: "state",
            required: true,
            schema: {
              type: "string",
            },
          },
          {
            in: "query",
            name: "code",
            required: true,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Auth",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["oauth.invalid_state"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["oauth.email_not_verified"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["oauth.email_conflict"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [],
        summary: "Complete google sign in",
        "x-chalk-rate-limit": {
          limit: 30,
          name: "auth.oauth.callback",
          window_seconds: 60,
        },
      },
    },
    "/v1/auth/google/start": {
      get: {
        operationId: "startGoogleSignIn",
        responses: {
          302: {
            description: "Found",
            headers: {
              Location: {
                required: true,
                schema: {
                  type: "string",
                },
              },
            },
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["oauth.not_configured", "service.unavailable"],
          },
        },
        security: [],
        summary: "Start google sign in",
        "x-chalk-rate-limit": {
          limit: 20,
          name: "auth.oauth.start",
          window_seconds: 60,
        },
      },
    },
    "/v1/auth/login": {
      post: {
        operationId: "login",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/LoginRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Auth",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["access.invalid_password", "identity.invalid_email", "request.invalid"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.invalid_credentials"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [],
        summary: "Login",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 10,
          name: "auth.login",
          window_seconds: 60,
        },
      },
    },
    "/v1/auth/logout": {
      post: {
        operationId: "logout",
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Status",
                },
              },
            },
            description: "OK",
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Logout",
      },
    },
    "/v1/auth/register": {
      post: {
        operationId: "register",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/RegisterRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Auth",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["access.invalid_password", "identity.invalid_email", "request.invalid", "user.invalid_name"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["identity.email_verification_required"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["identity.email_registered"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [],
        summary: "Register",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 5,
          name: "auth.register",
          window_seconds: 60,
        },
      },
    },
    "/v1/chat/attachments/uploads": {
      post: {
        operationId: "initiateChatAttachmentUpload",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/InitiateChatAttachmentUploadRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ChatAttachmentUpload",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["chat.invalid_attachment"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["chat.attachment_not_found", "chat.upload_not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["chat.attachment_id_conflict", "chat.attachment_quota_exceeded", "chat.upload_not_ready"],
          },
          410: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Gone",
            "x-chalk-error-codes": ["chat.upload_expired"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          502: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Gateway",
            "x-chalk-error-codes": ["chat.attachment_transfer_failed"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["chat.storage_unavailable", "service.unavailable"],
          },
        },
        security: [
          {
            participantSyncBearer: [],
          },
        ],
        summary: "Initiate chat attachment upload",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/chat/attachments/uploads/{uploadId}/finalize": {
      post: {
        operationId: "finalizeChatAttachmentUpload",
        parameters: [
          {
            in: "path",
            name: "uploadId",
            required: true,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ChatAttachment",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["chat.invalid_attachment"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["chat.attachment_not_found", "chat.upload_not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["chat.attachment_id_conflict", "chat.attachment_quota_exceeded", "chat.upload_not_ready"],
          },
          410: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Gone",
            "x-chalk-error-codes": ["chat.upload_expired"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          502: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Gateway",
            "x-chalk-error-codes": ["chat.attachment_transfer_failed"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["chat.storage_unavailable", "service.unavailable"],
          },
        },
        security: [
          {
            participantSyncBearer: [],
          },
        ],
        summary: "Finalize chat attachment upload",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/chat/attachments/{attachmentId}/download": {
      get: {
        operationId: "getChatAttachmentDownload",
        parameters: [
          {
            in: "path",
            name: "attachmentId",
            required: true,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ChatAttachmentDownload",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["chat.invalid_attachment"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["chat.attachment_not_found", "chat.upload_not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["chat.attachment_id_conflict", "chat.attachment_quota_exceeded", "chat.upload_not_ready"],
          },
          410: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Gone",
            "x-chalk-error-codes": ["chat.upload_expired"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          502: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Gateway",
            "x-chalk-error-codes": ["chat.attachment_transfer_failed"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["chat.storage_unavailable", "service.unavailable"],
          },
        },
        security: [
          {
            participantSyncBearer: [],
          },
        ],
        summary: "Get chat attachment download",
      },
    },
    "/v1/me": {
      get: {
        operationId: "getMe",
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AuthUser",
                },
              },
            },
            description: "OK",
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Get me",
        "x-chalk-rate-limit": {
          limit: 100,
          name: "auth.me",
          window_seconds: 60,
        },
      },
    },
    "/v1/me/recent-auth": {
      post: {
        operationId: "issueRecentAuthProof",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/RecentAuthRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/RecentAuth",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["request.invalid"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated", "auth.invalid_recent_auth"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Issue recent auth proof",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 10,
          name: "auth.recent_auth",
          window_seconds: 60,
        },
      },
    },
    "/v1/me/recent-auth/google/callback": {
      get: {
        operationId: "completeRecentAuthGoogle",
        parameters: [
          {
            in: "query",
            name: "state",
            required: true,
            schema: {
              type: "string",
            },
          },
          {
            in: "query",
            name: "code",
            required: true,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/RecentAuth",
                },
              },
            },
            description: "OK",
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated", "auth.invalid_recent_auth"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["oauth.not_configured", "service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Complete recent auth google",
        "x-chalk-rate-limit": {
          limit: 30,
          name: "auth.oauth.callback",
          window_seconds: 60,
        },
      },
    },
    "/v1/me/recent-auth/google/start": {
      get: {
        operationId: "startRecentAuthGoogle",
        parameters: [
          {
            in: "query",
            name: "action",
            required: true,
            schema: {
              maxLength: 64,
              type: "string",
            },
          },
          {
            in: "query",
            name: "resource_id",
            required: false,
            schema: {
              $ref: "#/components/schemas/UUID",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/RecentAuthGoogleStart",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["request.invalid"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["oauth.not_configured", "service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Start recent auth google",
        "x-chalk-rate-limit": {
          limit: 20,
          name: "auth.oauth.start",
          window_seconds: 60,
        },
      },
    },
    "/v1/me/tenants": {
      get: {
        operationId: "listMyTenants",
        parameters: [
          {
            in: "query",
            name: "page_size",
            required: false,
            schema: {
              type: "integer",
            },
          },
          {
            in: "query",
            name: "cursor",
            required: false,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AccountTenantList",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["pagination.invalid_cursor", "pagination.invalid_page_size"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "List my tenants",
      },
      post: {
        operationId: "onboardTenant",
        parameters: [
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/OnboardTenantRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AccountTenantOnboardingResponse",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["request.invalid", "request.invalid_idempotency_key", "tenant.invalid_name", "tenant.invalid_region"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["request.idempotency_conflict"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Onboard tenant",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/ops/ingest/monitor-results": {
      post: {
        operationId: "ingestMonitorResult",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/StatusMonitorResult",
              },
            },
          },
          required: true,
        },
        responses: {
          202: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/StatusMonitorResultAccepted",
                },
              },
            },
            description: "Accepted",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["status.invalid_result"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["status.unavailable"],
          },
        },
        security: [
          {
            opsIngestToken: [],
          },
        ],
        summary: "Ingest monitor result",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 600,
          name: "v1.telemetry.intake",
          window_seconds: 60,
        },
      },
    },
    "/v1/public/space-invite-arrival": {
      delete: {
        operationId: "leaveSpacePublicInviteArrival",
        parameters: [
          {
            in: "header",
            name: "X-Chalk-Arrival-Handle",
            required: true,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          204: {
            description: "No Content",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["arrival.invalid_handle", "request.invalid", "request.invalid_idempotency_key"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["arrival.unavailable", "space_public_invite.unavailable"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["episode.capacity_exceeded", "request.idempotency_conflict"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [],
        summary: "Leave space public invite arrival",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
      get: {
        operationId: "getSpacePublicInviteArrival",
        parameters: [
          {
            in: "header",
            name: "X-Chalk-Arrival-Handle",
            required: true,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/PublicSpaceArrival",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["arrival.invalid_handle", "request.invalid", "request.invalid_idempotency_key"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["arrival.unavailable", "space_public_invite.unavailable"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["episode.capacity_exceeded", "request.idempotency_conflict"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [],
        summary: "Get space public invite arrival",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/public/space-invite-arrival/access-grants": {
      post: {
        operationId: "refreshSpacePublicInviteAccess",
        parameters: [
          {
            in: "header",
            name: "X-Chalk-Arrival-Handle",
            required: true,
            schema: {
              type: "string",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/RefreshSpacePublicInviteAccessRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AccessGrant",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["arrival.invalid_handle", "request.invalid", "request.invalid_idempotency_key"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["arrival.unavailable", "space_public_invite.unavailable"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["episode.capacity_exceeded", "request.idempotency_conflict"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [],
        summary: "Refresh space public invite access",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/public/space-invite-arrivals": {
      post: {
        operationId: "arriveBySpacePublicInvite",
        parameters: [
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
          {
            in: "header",
            name: "X-Chalk-Arrival-Handle",
            required: false,
            schema: {
              type: "string",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/SpacePublicInviteArrivalRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/PublicSpaceArrival",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["arrival.invalid_handle", "request.invalid", "request.invalid_idempotency_key"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["arrival.unavailable", "space_public_invite.unavailable"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["episode.capacity_exceeded", "request.idempotency_conflict"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [],
        summary: "Arrive by space public invite",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/public/spaces": {
      post: {
        operationId: "createPublicSpace",
        parameters: [
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CreatePublicSpaceRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/PublicSpaceCreated",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["arrival.invalid_handle", "request.invalid", "request.invalid_idempotency_key"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["arrival.unavailable", "space_public_invite.unavailable"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["episode.capacity_exceeded", "request.idempotency_conflict"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [],
        summary: "Create public space",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/regions": {
      get: {
        operationId: "listRegions",
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Regions",
                },
              },
            },
            description: "OK",
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "List regions",
      },
    },
    "/v1/status": {
      get: {
        operationId: "getPublicStatus",
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/PublicStatus",
                },
              },
            },
            description: "OK",
            headers: {
              "Cache-Control": {
                required: true,
                schema: {
                  type: "string",
                },
              },
            },
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["status.unavailable"],
          },
        },
        security: [],
        summary: "Get public status",
      },
    },
    "/v1/telemetry/journey-events": {
      post: {
        operationId: "intakeJourneyEvents",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/JourneyEventBatch",
              },
            },
          },
          required: true,
        },
        responses: {
          202: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/JourneyEventIntake",
                },
              },
            },
            description: "Accepted",
            headers: {
              "x-chalk-journey-id": {
                required: false,
                schema: {
                  type: "string",
                },
              },
            },
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["journey.invalid_event", "request.invalid"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["journey.ledger_unavailable", "service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Intake journey events",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 600,
          name: "v1.telemetry.intake",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants": {
      get: {
        operationId: "listTenants",
        parameters: [
          {
            in: "query",
            name: "page_size",
            required: false,
            schema: {
              type: "integer",
            },
          },
          {
            in: "query",
            name: "cursor",
            required: false,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/TenantList",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["pagination.invalid_cursor", "pagination.invalid_page_size"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "List tenants",
      },
      post: {
        operationId: "createTenant",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CreateTenantRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Tenant",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["request.invalid", "tenant.invalid_field", "tenant.invalid_name", "tenant.invalid_region"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Create tenant",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}": {
      get: {
        operationId: "getTenant",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Tenant",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["tenant.not_found"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Get tenant",
      },
      patch: {
        operationId: "updateTenant",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/UpdateTenantRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Tenant",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["request.invalid", "tenant.invalid_field", "tenant.invalid_id", "tenant.invalid_name", "tenant.invalid_region"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["tenant.not_found"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Update tenant",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/api-keys": {
      get: {
        operationId: "listAPIKeys",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "query",
            name: "page_size",
            required: false,
            schema: {
              type: "integer",
            },
          },
          {
            in: "query",
            name: "cursor",
            required: false,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/APIKeyList",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["pagination.invalid_cursor", "pagination.invalid_page_size", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "List a p i keys",
      },
      post: {
        operationId: "createAPIKey",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
          {
            in: "header",
            name: "X-Chalk-Recent-Auth",
            required: true,
            schema: {
              type: "string",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CreateAPIKeyRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/APIKeyWithSecret",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["request.invalid", "request.invalid_idempotency_key", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated", "auth.invalid_recent_auth"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["api_key.secret_not_replayable", "request.idempotency_conflict"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          428: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Precondition Required",
            "x-chalk-error-codes": ["access.recent_auth_required"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Create a p i key",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/api-keys/{api_key_id}": {
      delete: {
        operationId: "revokeAPIKey",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "api_key_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/UUID",
            },
          },
          {
            in: "header",
            name: "X-Chalk-Recent-Auth",
            required: true,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          204: {
            description: "No Content",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["api_key.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated", "auth.invalid_recent_auth"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["api_key.not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["api_key.inactive"],
          },
          428: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Precondition Required",
            "x-chalk-error-codes": ["access.recent_auth_required"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Revoke a p i key",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/api-keys/{api_key_id}/rotate": {
      post: {
        operationId: "rotateAPIKey",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "api_key_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/UUID",
            },
          },
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
          {
            in: "header",
            name: "X-Chalk-Recent-Auth",
            required: true,
            schema: {
              type: "string",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/RotateAPIKeyRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/APIKeyWithSecret",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["api_key.invalid_id", "request.invalid", "request.invalid_idempotency_key", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated", "auth.invalid_recent_auth"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["api_key.not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["api_key.inactive", "api_key.secret_not_replayable", "request.idempotency_conflict"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          428: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Precondition Required",
            "x-chalk-error-codes": ["access.recent_auth_required"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Rotate a p i key",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/audit-logs": {
      get: {
        operationId: "listAuditLogs",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "query",
            name: "page_size",
            required: false,
            schema: {
              type: "integer",
            },
          },
          {
            in: "query",
            name: "cursor",
            required: false,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AuditLogList",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["pagination.invalid_cursor", "pagination.invalid_page_size", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "List audit logs",
      },
    },
    "/v1/tenants/{tenant_id}/audit-logs/{audit_log_id}": {
      get: {
        operationId: "getAuditLog",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "audit_log_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/AuditLogId",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AuditLog",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["audit.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["audit.not_found"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Get audit log",
      },
    },
    "/v1/tenants/{tenant_id}/integrations/connections": {
      get: {
        operationId: "listIntegrationConnections",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "query",
            name: "provider",
            required: false,
            schema: {
              type: "string",
            },
          },
          {
            in: "query",
            name: "service",
            required: false,
            schema: {
              type: "string",
            },
          },
          {
            in: "query",
            name: "status",
            required: false,
            schema: {
              type: "string",
            },
          },
          {
            in: "query",
            name: "page_size",
            required: false,
            schema: {
              type: "integer",
            },
          },
          {
            in: "query",
            name: "cursor",
            required: false,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/IntegrationConnectionList",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["integration.invalid_provider", "integration.invalid_service", "pagination.invalid_cursor", "pagination.invalid_page_size", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "List integration connections",
      },
      post: {
        operationId: "startIntegrationConnection",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/StartIntegrationConnectionRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/IntegrationConnectionStart",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["integration.invalid_callback_url", "integration.invalid_provider", "integration.invalid_service", "request.invalid", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["integration.connection_already_exists"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          502: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Gateway",
            "x-chalk-error-codes": ["integration.provider_unavailable"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["integration.provider_unavailable", "service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Start integration connection",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/integrations/connections/{connection_id}": {
      delete: {
        operationId: "disableIntegrationConnection",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "connection_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/UUID",
            },
          },
          {
            in: "query",
            name: "revoke",
            required: false,
            schema: {
              type: "boolean",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/IntegrationConnection",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["integration.invalid_connection_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["integration.connection_not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["integration.connection_not_active"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["integration.provider_rate_limited", "request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          502: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Gateway",
            "x-chalk-error-codes": ["integration.provider_unauthorized", "integration.provider_unavailable"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["integration.provider_unavailable", "service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Disable integration connection",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
      get: {
        operationId: "getIntegrationConnection",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "connection_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/UUID",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/IntegrationConnection",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["integration.invalid_connection_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["integration.connection_not_found"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Get integration connection",
      },
    },
    "/v1/tenants/{tenant_id}/integrations/connections/{connection_id}/actions": {
      post: {
        operationId: "executeIntegrationAction",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "connection_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/UUID",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/ExecuteIntegrationActionRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/IntegrationActionExecution",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["integration.invalid_action", "integration.invalid_action_input", "integration.invalid_action_text", "integration.invalid_connection_id", "request.invalid", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden", "integration.action_not_allowed"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["integration.connection_not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["integration.connection_not_active"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["integration.provider_rate_limited", "request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          502: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Gateway",
            "x-chalk-error-codes": ["integration.provider_unauthorized", "integration.provider_unavailable"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["integration.provider_unavailable", "service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Execute integration action",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/integrations/connections/{connection_id}/refresh": {
      post: {
        operationId: "refreshIntegrationConnection",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "connection_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/UUID",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/IntegrationConnectionRefresh",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["integration.invalid_connection_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["integration.connection_not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["integration.connection_not_active"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["integration.provider_rate_limited", "request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          502: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Gateway",
            "x-chalk-error-codes": ["integration.provider_unauthorized", "integration.provider_unavailable"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["integration.provider_unavailable", "service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Refresh integration connection",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/integrations/services": {
      get: {
        operationId: "listIntegrationServices",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/IntegrationServices",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "List integration services",
      },
    },
    "/v1/tenants/{tenant_id}/memberships": {
      get: {
        operationId: "listMemberships",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "query",
            name: "page_size",
            required: false,
            schema: {
              type: "integer",
            },
          },
          {
            in: "query",
            name: "cursor",
            required: false,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/MembershipList",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["pagination.invalid_cursor", "pagination.invalid_page_size", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "List memberships",
      },
      post: {
        operationId: "createMembership",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CreateMembershipRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Membership",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["membership.invalid_role", "request.invalid", "tenant.invalid_id", "user.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Create membership",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/memberships/{membership_id}": {
      patch: {
        operationId: "updateMembership",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "membership_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/MembershipId",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/UpdateMembershipRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Membership",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["membership.invalid_id", "membership.invalid_role", "request.invalid", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["membership.not_found"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Update membership",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/recording-reservations/{recording_reservation_id}": {
      delete: {
        operationId: "releaseRecordingReservation",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "recording_reservation_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/UUID",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/RecordingReservation",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["recording_reservation.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["recording_reservation.not_found"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Release recording reservation",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
      get: {
        operationId: "getRecordingReservation",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "recording_reservation_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/UUID",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/RecordingReservation",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["recording_reservation.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["recording_reservation.not_found"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Get recording reservation",
      },
      patch: {
        operationId: "extendRecordingReservation",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "recording_reservation_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/UUID",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/ExtendRecordingReservationRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/RecordingReservation",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["recording.invalid_duration", "recording_reservation.invalid_id", "request.invalid", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["recording_reservation.not_found"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["recording.capacity_unavailable", "service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Extend recording reservation",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/recordings": {
      get: {
        operationId: "listRecordings",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "query",
            name: "episode_id",
            required: false,
            schema: {
              $ref: "#/components/schemas/EpisodeId",
            },
          },
          {
            in: "query",
            name: "page_size",
            required: false,
            schema: {
              type: "integer",
            },
          },
          {
            in: "query",
            name: "cursor",
            required: false,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/RecordingList",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["episode.invalid_id", "pagination.invalid_cursor", "pagination.invalid_page_size", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "List recordings",
      },
    },
    "/v1/tenants/{tenant_id}/recordings/{recording_id}": {
      get: {
        operationId: "getRecording",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "recording_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/RecordingId",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Recording",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["recording.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["recording.not_found"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Get recording",
      },
      patch: {
        operationId: "updateRecording",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "recording_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/RecordingId",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/UpdateRecordingRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Recording",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["recording.invalid_field", "recording.invalid_id", "recording.invalid_status", "request.invalid", "storage.invalid_key", "storage.invalid_provider", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["recording.not_found"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Update recording",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/recordings/{recording_id}/download-url": {
      post: {
        operationId: "createRecordingDownloadURL",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "recording_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/RecordingId",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CreateRecordingDownloadURLRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/RecordingDownloadURL",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["recording.invalid_id", "recording.not_ready", "request.invalid", "storage.invalid_key", "storage.invalid_provider", "tenant.invalid_id", "url.invalid_expiration"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["recording.not_found", "recording_artifact.not_found"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Create recording download u r l",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/recordings/{recording_id}/pipeline": {
      get: {
        operationId: "getRecordingPipeline",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "recording_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/RecordingId",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/RecordingPipeline",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["recording.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["recording.not_found"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Get recording pipeline",
      },
    },
    "/v1/tenants/{tenant_id}/recordings/{recording_id}/transcripts": {
      post: {
        operationId: "requestTranscript",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "recording_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/RecordingId",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/RequestTranscriptRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          202: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/TranscriptRequestAcceptedResponse",
                },
              },
            },
            description: "Accepted",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["recording.invalid_id", "recording.not_ready", "request.invalid", "tenant.invalid_id", "transcript.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["recording.not_found"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Request transcript",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces": {
      get: {
        operationId: "listSpaces",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "query",
            name: "archived",
            required: false,
            schema: {
              type: "boolean",
            },
          },
          {
            in: "query",
            name: "page_size",
            required: false,
            schema: {
              type: "integer",
            },
          },
          {
            in: "query",
            name: "cursor",
            required: false,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/SpaceList",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["pagination.invalid_cursor", "pagination.invalid_page_size", "space.invalid_archive_filter", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "List spaces",
      },
      post: {
        operationId: "createSpace",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CreateSpaceRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Space",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["request.invalid", "request.invalid_idempotency_key", "space.invalid_media_plane", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["request.idempotency_conflict", "space.slug_conflict"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Create space",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/by-slug/{space_slug}/participants/self": {
      delete: {
        operationId: "leaveDashboardSpaceSelf",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_slug",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 1,
              pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
              type: "string",
            },
          },
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/LeaveDashboardSpaceSelfRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          204: {
            description: "No Content",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["request.invalid", "request.invalid_idempotency_key", "space.invalid_slug", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["space.not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["episode.not_active", "participant.generation_mismatch", "participant.not_active", "request.idempotency_conflict"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Leave dashboard space self",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
      post: {
        operationId: "joinDashboardSpaceSelf",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_slug",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 1,
              pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
              type: "string",
            },
          },
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/DashboardSpaceSelfJoinRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AccessGrant",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["request.invalid", "request.invalid_idempotency_key", "space.invalid_slug", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["space.not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["episode.capacity_exceeded", "episode.not_active", "participant.not_active", "request.idempotency_conflict"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["media.unavailable", "service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Join dashboard space self",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/by-slug/{space_slug}/participants/self/access-grants": {
      post: {
        operationId: "refreshDashboardSpaceSelfAccess",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_slug",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 1,
              pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
              type: "string",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/IssueAccessGrantRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AccessGrant",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["request.invalid", "space.invalid_slug", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["episode.not_found", "participant.not_found", "space.not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["participant.generation_mismatch"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["media.unavailable", "service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Refresh dashboard space self access",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}": {
      get: {
        operationId: "getSpace",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Space",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["space.not_found"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Get space",
      },
      patch: {
        operationId: "updateSpace",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/UpdateSpaceRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Space",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["request.invalid", "space.invalid_id", "space.invalid_media_plane", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["space.not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["space.slug_conflict"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Update space",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/archive": {
      post: {
        operationId: "archiveSpace",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Space",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["space.not_found"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Archive space",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes": {
      get: {
        operationId: "listEpisodes",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
          {
            in: "query",
            name: "page_size",
            required: false,
            schema: {
              type: "integer",
            },
          },
          {
            in: "query",
            name: "cursor",
            required: false,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/EpisodeList",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["pagination.invalid_cursor", "pagination.invalid_page_size", "space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["episode.not_found", "space.not_found"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "List episodes",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
      post: {
        operationId: "createEpisode",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CreateEpisodeRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Episode",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["request.invalid", "request.invalid_idempotency_key", "space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["episode.not_found", "space.not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["episode.capacity_exceeded", "request.idempotency_conflict"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Create episode",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}": {
      get: {
        operationId: "getEpisode",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
          {
            in: "path",
            name: "episode_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/EpisodeId",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Episode",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["episode.invalid_id", "space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["episode.not_found", "space.not_found"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Get episode",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/deadline": {
      post: {
        operationId: "setEpisodeDeadline",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
          {
            in: "path",
            name: "episode_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/EpisodeId",
            },
          },
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/SetEpisodeDeadlineRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          202: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/EpisodeDeadline",
                },
              },
            },
            description: "Accepted",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["episode.invalid_id", "request.invalid", "request.invalid_idempotency_key", "space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["episode.not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["episode.not_active", "request.idempotency_conflict"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Set episode deadline",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/end": {
      post: {
        operationId: "endEpisode",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
          {
            in: "path",
            name: "episode_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/EpisodeId",
            },
          },
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
        ],
        responses: {
          202: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/EpisodeEnd",
                },
              },
            },
            description: "Accepted",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["episode.invalid_id", "request.invalid_idempotency_key", "space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["episode.not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["episode.capacity_exceeded", "episode.not_active", "request.idempotency_conflict"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "End episode",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants": {
      post: {
        operationId: "admitEpisodeParticipant",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
          {
            in: "path",
            name: "episode_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/EpisodeId",
            },
          },
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/AdmitEpisodeParticipantRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ParticipantLifecycle",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["episode.invalid_id", "participant.invalid_id", "request.invalid", "request.invalid_idempotency_key", "space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["episode.not_found", "space.not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["episode.capacity_exceeded", "episode.not_active", "request.idempotency_conflict"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["media.unavailable", "service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Admit episode participant",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/access-grant": {
      post: {
        operationId: "issueAccessGrant",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
          {
            in: "path",
            name: "episode_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/EpisodeId",
            },
          },
          {
            in: "path",
            name: "participant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/ParticipantId",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/IssueAccessGrantRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AccessGrant",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["episode.invalid_id", "participant.invalid_id", "request.invalid", "space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["participant.not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["participant.generation_mismatch"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["media.unavailable", "service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Issue access grant",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/media/sfu/publications": {
      get: {
        operationId: "listCloudflareSFUPublications",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
          {
            in: "path",
            name: "episode_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/EpisodeId",
            },
          },
          {
            in: "path",
            name: "participant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/ParticipantId",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/CloudflareSFUPublicationsResponse",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["episode.invalid_id", "participant.invalid_id", "space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["episode.not_found"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["media.unavailable", "service.unavailable"],
          },
        },
        security: [
          {
            participantMediaBearer: [],
          },
        ],
        summary: "List cloudflare s f u publications",
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/media/sfu/renegotiate": {
      post: {
        operationId: "renegotiateCloudflareSFU",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
          {
            in: "path",
            name: "episode_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/EpisodeId",
            },
          },
          {
            in: "path",
            name: "participant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/ParticipantId",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CloudflareSFURenegotiateRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/CloudflareSFURenegotiateResponse",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["episode.invalid_id", "participant.invalid_id", "request.invalid", "space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["episode.not_found"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["media.unavailable", "service.unavailable"],
          },
        },
        security: [
          {
            participantMediaBearer: [],
          },
        ],
        summary: "Renegotiate cloudflare s f u",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/media/sfu/tracks": {
      post: {
        operationId: "addCloudflareSFUTracks",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
          {
            in: "path",
            name: "episode_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/EpisodeId",
            },
          },
          {
            in: "path",
            name: "participant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/ParticipantId",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CloudflareSFUTracksRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/CloudflareSFUTracksAPIResponse",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["episode.invalid_id", "participant.invalid_id", "request.invalid", "space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["episode.not_found"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["media.unavailable", "service.unavailable"],
          },
        },
        security: [
          {
            participantMediaBearer: [],
          },
        ],
        summary: "Add cloudflare s f u tracks",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/media/sfu/tracks/close": {
      put: {
        operationId: "closeCloudflareSFUTracks",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
          {
            in: "path",
            name: "episode_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/EpisodeId",
            },
          },
          {
            in: "path",
            name: "participant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/ParticipantId",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CloudflareSFUCloseTracksRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/CloudflareSFUCloseTracksAPIResponse",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["episode.invalid_id", "participant.invalid_id", "request.invalid", "space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["episode.not_found"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["media.unavailable", "service.unavailable"],
          },
        },
        security: [
          {
            participantMediaBearer: [],
          },
        ],
        summary: "Close cloudflare s f u tracks",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/remove": {
      post: {
        operationId: "removeEpisodeParticipant",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
          {
            in: "path",
            name: "episode_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/EpisodeId",
            },
          },
          {
            in: "path",
            name: "participant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/ParticipantId",
            },
          },
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/RemoveEpisodeParticipantRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          202: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ParticipantRemoval",
                },
              },
            },
            description: "Accepted",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["episode.invalid_id", "participant.invalid_id", "request.invalid", "request.invalid_idempotency_key", "space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["episode.not_found", "participant.not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["episode.not_active", "participant.generation_mismatch", "participant.not_active", "request.idempotency_conflict"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Remove episode participant",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/sync-token": {
      post: {
        operationId: "issueEpisodeParticipantSyncToken",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
          {
            in: "path",
            name: "episode_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/EpisodeId",
            },
          },
          {
            in: "path",
            name: "participant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/ParticipantId",
            },
          },
        ],
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/SyncToken",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["episode.invalid_id", "participant.invalid_id", "space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["participant.not_found"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Issue episode participant sync token",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/recording-reservations": {
      post: {
        operationId: "createRecordingReservation",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
          {
            in: "path",
            name: "episode_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/EpisodeId",
            },
          },
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CreateRecordingReservationRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/RecordingReservation",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["episode.invalid_id", "recording.invalid_bitrate", "recording.invalid_duration", "recording.invalid_participant_count", "request.invalid", "request.invalid_idempotency_key", "space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["episode.not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["request.idempotency_conflict"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["recording.capacity_unavailable", "service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Create recording reservation",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/recordings": {
      post: {
        operationId: "createRecording",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
          {
            in: "path",
            name: "episode_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/EpisodeId",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CreateRecordingRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Recording",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["episode.invalid_id", "recording.invalid_field", "recording.invalid_status", "request.invalid", "space.invalid_id", "storage.invalid_key", "storage.invalid_provider", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["episode.not_found"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Create recording",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/public-admission-requests": {
      get: {
        operationId: "listSpacePublicAdmissionRequests",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
          {
            in: "query",
            name: "state",
            required: false,
            schema: {
              enum: ["pending"],
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/PublicAdmissionRequestPage",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["request.invalid", "request.invalid_idempotency_key", "space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["admission_request.not_found", "space.not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["request.idempotency_conflict"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "List space public admission requests",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/public-admission-requests/{request_handle}/approval": {
      post: {
        operationId: "approveSpacePublicAdmissionRequest",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
          {
            in: "path",
            name: "request_handle",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]{16,128}$",
              type: "string",
            },
          },
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/PublicAdmissionRequest",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["request.invalid", "request.invalid_idempotency_key", "space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["admission_request.not_found", "space.not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["request.idempotency_conflict"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Approve space public admission request",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/public-admission-requests/{request_handle}/denial": {
      post: {
        operationId: "denySpacePublicAdmissionRequest",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
          {
            in: "path",
            name: "request_handle",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]{16,128}$",
              type: "string",
            },
          },
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/PublicAdmissionRequest",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["request.invalid", "request.invalid_idempotency_key", "space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["admission_request.not_found", "space.not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["request.idempotency_conflict"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Deny space public admission request",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/public-invite": {
      get: {
        operationId: "getSpacePublicInvite",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/SpacePublicInvite",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["request.invalid", "request.invalid_idempotency_key", "space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["admission_request.not_found", "space.not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["request.idempotency_conflict"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Get space public invite",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
      patch: {
        operationId: "updateSpacePublicInvite",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/UpdateSpacePublicInviteRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/SpacePublicInvite",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["request.invalid", "request.invalid_idempotency_key", "space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["admission_request.not_found", "space.not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["request.idempotency_conflict"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Update space public invite",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/public-invite/rotations": {
      post: {
        operationId: "rotateSpacePublicInvite",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
        ],
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/SpacePublicInvite",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["request.invalid", "request.invalid_idempotency_key", "space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["admission_request.not_found", "space.not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["request.idempotency_conflict"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Rotate space public invite",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/spaces/{space_id}/restore": {
      post: {
        operationId: "restoreSpace",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "space_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/SpaceId",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Space",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["space.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["space.not_found"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Restore space",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/transcripts": {
      get: {
        operationId: "listTranscripts",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "query",
            name: "recording_id",
            required: false,
            schema: {
              $ref: "#/components/schemas/RecordingId",
            },
          },
          {
            in: "query",
            name: "page_size",
            required: false,
            schema: {
              type: "integer",
            },
          },
          {
            in: "query",
            name: "cursor",
            required: false,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/TranscriptList",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["pagination.invalid_cursor", "pagination.invalid_page_size", "recording.invalid_id", "tenant.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "List transcripts",
      },
    },
    "/v1/tenants/{tenant_id}/transcripts/{transcript_id}": {
      delete: {
        operationId: "deleteTranscript",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "transcript_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TranscriptId",
            },
          },
        ],
        responses: {
          204: {
            description: "No Content",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["tenant.invalid_id", "transcript.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["transcript.not_found"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Delete transcript",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
      get: {
        operationId: "getTranscript",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "transcript_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TranscriptId",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Transcript",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["tenant.invalid_id", "transcript.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["transcript.not_found"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Get transcript",
      },
    },
    "/v1/tenants/{tenant_id}/transcripts/{transcript_id}/download-url": {
      post: {
        operationId: "createTranscriptDownloadURL",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "transcript_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TranscriptId",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CreateTranscriptDownloadURLRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/TranscriptDownloadURL",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["tenant.invalid_id", "url.invalid_expiration"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["transcript.not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["transcript.not_ready"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Create transcript download u r l",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/webhook-endpoints": {
      get: {
        operationId: "listWebhookEndpoints",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "query",
            name: "page_size",
            required: false,
            schema: {
              type: "integer",
            },
          },
          {
            in: "query",
            name: "cursor",
            required: false,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/WebhookEndpointList",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["pagination.invalid_cursor", "pagination.invalid_page_size", "tenant.invalid_id", "webhook.invalid_delivery_id", "webhook.invalid_endpoint_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["webhook.delivery_not_found", "webhook.endpoint_not_found"],
          },
          410: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Gone",
            "x-chalk-error-codes": ["webhook.event_erased"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "List webhook endpoints",
        "x-chalk-rate-limit": {
          limit: 300,
          name: "v1.webhooks.read",
          window_seconds: 60,
        },
      },
      post: {
        operationId: "createWebhookEndpoint",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CreateWebhookEndpointRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/WebhookEndpointWithSecret",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": [
              "pagination.invalid_cursor",
              "pagination.invalid_page_size",
              "request.invalid",
              "tenant.invalid_id",
              "webhook.idempotency_key_required",
              "webhook.invalid_api_version",
              "webhook.invalid_delivery_id",
              "webhook.invalid_endpoint_id",
              "webhook.invalid_event_type",
              "webhook.invalid_url",
              "webhook.unsafe_url",
            ],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["webhook.delivery_not_found", "webhook.endpoint_not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["webhook.delivery_not_redeliverable", "webhook.endpoint_limit_reached", "webhook.event_type_unavailable", "webhook.idempotency_conflict", "webhook.idempotency_expired"],
          },
          410: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Gone",
            "x-chalk-error-codes": ["webhook.event_erased"],
          },
          412: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Precondition Failed",
            "x-chalk-error-codes": ["webhook.endpoint_revision_conflict"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Create webhook endpoint",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}": {
      delete: {
        operationId: "deleteWebhookEndpoint",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "endpoint_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/UUID",
            },
          },
          {
            in: "header",
            name: "If-Match",
            required: true,
            schema: {
              pattern: '^"[1-9][0-9]*"$',
              type: "string",
            },
          },
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
        ],
        responses: {
          204: {
            description: "No Content",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": [
              "pagination.invalid_cursor",
              "pagination.invalid_page_size",
              "request.invalid",
              "tenant.invalid_id",
              "webhook.idempotency_key_required",
              "webhook.invalid_api_version",
              "webhook.invalid_delivery_id",
              "webhook.invalid_endpoint_id",
              "webhook.invalid_event_type",
              "webhook.invalid_url",
              "webhook.unsafe_url",
            ],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["webhook.delivery_not_found", "webhook.endpoint_not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["webhook.delivery_not_redeliverable", "webhook.endpoint_limit_reached", "webhook.event_type_unavailable", "webhook.idempotency_conflict", "webhook.idempotency_expired"],
          },
          410: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Gone",
            "x-chalk-error-codes": ["webhook.event_erased"],
          },
          412: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Precondition Failed",
            "x-chalk-error-codes": ["webhook.endpoint_revision_conflict"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Delete webhook endpoint",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
      get: {
        operationId: "getWebhookEndpoint",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "endpoint_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/UUID",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/WebhookEndpoint",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["pagination.invalid_cursor", "pagination.invalid_page_size", "tenant.invalid_id", "webhook.invalid_delivery_id", "webhook.invalid_endpoint_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["webhook.delivery_not_found", "webhook.endpoint_not_found"],
          },
          410: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Gone",
            "x-chalk-error-codes": ["webhook.event_erased"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Get webhook endpoint",
        "x-chalk-rate-limit": {
          limit: 300,
          name: "v1.webhooks.read",
          window_seconds: 60,
        },
      },
      patch: {
        operationId: "updateWebhookEndpoint",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "endpoint_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/UUID",
            },
          },
          {
            in: "header",
            name: "If-Match",
            required: true,
            schema: {
              pattern: '^"[1-9][0-9]*"$',
              type: "string",
            },
          },
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/UpdateWebhookEndpointRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/WebhookEndpoint",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": [
              "pagination.invalid_cursor",
              "pagination.invalid_page_size",
              "request.invalid",
              "tenant.invalid_id",
              "webhook.idempotency_key_required",
              "webhook.invalid_api_version",
              "webhook.invalid_delivery_id",
              "webhook.invalid_endpoint_id",
              "webhook.invalid_event_type",
              "webhook.invalid_url",
              "webhook.unsafe_url",
            ],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["webhook.delivery_not_found", "webhook.endpoint_not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["webhook.delivery_not_redeliverable", "webhook.endpoint_limit_reached", "webhook.event_type_unavailable", "webhook.idempotency_conflict", "webhook.idempotency_expired"],
          },
          410: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Gone",
            "x-chalk-error-codes": ["webhook.event_erased"],
          },
          412: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Precondition Failed",
            "x-chalk-error-codes": ["webhook.endpoint_revision_conflict"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Update webhook endpoint",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/deliveries": {
      get: {
        operationId: "listWebhookDeliveries",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "endpoint_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/UUID",
            },
          },
          {
            in: "query",
            name: "state",
            required: false,
            schema: {
              items: {
                enum: ["pending", "retry_wait", "delivering", "succeeded", "exhausted", "canceled", "erased"],
                type: "string",
              },
              type: "array",
            },
          },
          {
            in: "query",
            name: "event_type",
            required: false,
            schema: {
              items: {
                enum: [
                  "endpoint.test",
                  "episode.ended",
                  "episode.started",
                  "participant.joined",
                  "participant.left",
                  "recording.completed",
                  "recording.failed",
                  "recording.started",
                  "space.archived",
                  "space.created",
                  "space.restored",
                  "space.updated",
                  "transcript.completed",
                  "transcript.failed",
                  "transcript.started",
                ],
                type: "string",
              },
              type: "array",
            },
          },
          {
            in: "query",
            name: "page_size",
            required: false,
            schema: {
              type: "integer",
            },
          },
          {
            in: "query",
            name: "cursor",
            required: false,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/WebhookDeliveryList",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["pagination.invalid_cursor", "pagination.invalid_page_size", "tenant.invalid_id", "webhook.invalid_delivery_id", "webhook.invalid_endpoint_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["webhook.delivery_not_found", "webhook.endpoint_not_found"],
          },
          410: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Gone",
            "x-chalk-error-codes": ["webhook.event_erased"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "List webhook deliveries",
        "x-chalk-rate-limit": {
          limit: 300,
          name: "v1.webhooks.read",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/deliveries/{delivery_id}": {
      get: {
        operationId: "getWebhookDelivery",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "endpoint_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/UUID",
            },
          },
          {
            in: "path",
            name: "delivery_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/UUID",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/WebhookDeliveryDetail",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["pagination.invalid_cursor", "pagination.invalid_page_size", "tenant.invalid_id", "webhook.invalid_delivery_id", "webhook.invalid_endpoint_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["webhook.delivery_not_found", "webhook.endpoint_not_found"],
          },
          410: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Gone",
            "x-chalk-error-codes": ["webhook.event_erased"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Get webhook delivery",
        "x-chalk-rate-limit": {
          limit: 300,
          name: "v1.webhooks.read",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/deliveries/{delivery_id}/redeliver": {
      post: {
        operationId: "redeliverWebhookDelivery",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "endpoint_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/UUID",
            },
          },
          {
            in: "path",
            name: "delivery_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/UUID",
            },
          },
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
        ],
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/WebhookDeliveryCreated",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": [
              "pagination.invalid_cursor",
              "pagination.invalid_page_size",
              "request.invalid",
              "tenant.invalid_id",
              "webhook.idempotency_key_required",
              "webhook.invalid_api_version",
              "webhook.invalid_delivery_id",
              "webhook.invalid_endpoint_id",
              "webhook.invalid_event_type",
              "webhook.invalid_url",
              "webhook.unsafe_url",
            ],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["webhook.delivery_not_found", "webhook.endpoint_not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["webhook.delivery_not_redeliverable", "webhook.endpoint_limit_reached", "webhook.event_type_unavailable", "webhook.idempotency_conflict", "webhook.idempotency_expired"],
          },
          410: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Gone",
            "x-chalk-error-codes": ["webhook.event_erased"],
          },
          412: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Precondition Failed",
            "x-chalk-error-codes": ["webhook.endpoint_revision_conflict"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Redeliver webhook delivery",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/rotate-secret": {
      post: {
        operationId: "rotateWebhookEndpointSecret",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "endpoint_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/UUID",
            },
          },
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/RotateWebhookSecretRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/RotateWebhookSecretResponse",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": [
              "pagination.invalid_cursor",
              "pagination.invalid_page_size",
              "request.invalid",
              "tenant.invalid_id",
              "webhook.idempotency_key_required",
              "webhook.invalid_api_version",
              "webhook.invalid_delivery_id",
              "webhook.invalid_endpoint_id",
              "webhook.invalid_event_type",
              "webhook.invalid_url",
              "webhook.unsafe_url",
            ],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["webhook.delivery_not_found", "webhook.endpoint_not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["webhook.delivery_not_redeliverable", "webhook.endpoint_limit_reached", "webhook.event_type_unavailable", "webhook.idempotency_conflict", "webhook.idempotency_expired"],
          },
          410: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Gone",
            "x-chalk-error-codes": ["webhook.event_erased"],
          },
          412: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Precondition Failed",
            "x-chalk-error-codes": ["webhook.endpoint_revision_conflict"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Rotate webhook endpoint secret",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/test": {
      post: {
        operationId: "testWebhookEndpoint",
        parameters: [
          {
            in: "path",
            name: "tenant_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/TenantId",
            },
          },
          {
            in: "path",
            name: "endpoint_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/UUID",
            },
          },
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 16,
              pattern: "^[A-Za-z0-9_-]+$",
              type: "string",
            },
          },
        ],
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/WebhookDeliveryCreated",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": [
              "pagination.invalid_cursor",
              "pagination.invalid_page_size",
              "request.invalid",
              "tenant.invalid_id",
              "webhook.idempotency_key_required",
              "webhook.invalid_api_version",
              "webhook.invalid_delivery_id",
              "webhook.invalid_endpoint_id",
              "webhook.invalid_event_type",
              "webhook.invalid_url",
              "webhook.unsafe_url",
            ],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["webhook.delivery_not_found", "webhook.endpoint_not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["webhook.delivery_not_redeliverable", "webhook.endpoint_limit_reached", "webhook.event_type_unavailable", "webhook.idempotency_conflict", "webhook.idempotency_expired"],
          },
          410: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Gone",
            "x-chalk-error-codes": ["webhook.event_erased"],
          },
          412: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Precondition Failed",
            "x-chalk-error-codes": ["webhook.endpoint_revision_conflict"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Test webhook endpoint",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/users": {
      get: {
        operationId: "listUsers",
        parameters: [
          {
            in: "query",
            name: "page_size",
            required: false,
            schema: {
              type: "integer",
            },
          },
          {
            in: "query",
            name: "cursor",
            required: false,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/UserList",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["pagination.invalid_cursor", "pagination.invalid_page_size"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "List users",
      },
      post: {
        operationId: "createUser",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CreateUserRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/User",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["request.invalid", "user.invalid_email", "user.invalid_name"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Create user",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/users/{user_id}": {
      get: {
        operationId: "getUser",
        parameters: [
          {
            in: "path",
            name: "user_id",
            required: true,
            schema: {
              $ref: "#/components/schemas/UserId",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/User",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["user.invalid_id"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["user.not_found"],
          },
          500: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Internal Server Error",
            "x-chalk-error-codes": ["service.internal_error"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable"],
          },
        },
        security: [
          {
            sessionOrBearer: [],
          },
        ],
        summary: "Get user",
      },
    },
    "/v1/whiteboard/files/uploads": {
      post: {
        operationId: "initiateWhiteboardFileUpload",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/InitiateWhiteboardFileUploadRequest",
              },
            },
          },
          required: true,
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/WhiteboardFileUpload",
                },
              },
            },
            description: "Created",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["whiteboard.invalid_file"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["whiteboard.file_not_found", "whiteboard.upload_not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["whiteboard.file_exists", "whiteboard.scene_changed", "whiteboard.upload_not_ready"],
          },
          410: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Gone",
            "x-chalk-error-codes": ["whiteboard.upload_expired"],
          },
          413: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Request Entity Too Large",
            "x-chalk-error-codes": ["request.payload_too_large"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          502: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Gateway",
            "x-chalk-error-codes": ["whiteboard.file_transfer_failed"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable", "whiteboard.storage_unavailable"],
          },
        },
        security: [
          {
            participantSyncBearer: [],
          },
        ],
        summary: "Initiate whiteboard file upload",
        "x-chalk-max-body-bytes": 1048576,
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/whiteboard/files/uploads/{uploadId}/finalize": {
      post: {
        operationId: "finalizeWhiteboardFileUpload",
        parameters: [
          {
            in: "path",
            name: "uploadId",
            required: true,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          204: {
            description: "No Content",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["whiteboard.invalid_file"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["whiteboard.file_not_found", "whiteboard.upload_not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["whiteboard.file_exists", "whiteboard.scene_changed", "whiteboard.upload_not_ready"],
          },
          410: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Gone",
            "x-chalk-error-codes": ["whiteboard.upload_expired"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          502: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Gateway",
            "x-chalk-error-codes": ["whiteboard.file_transfer_failed"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable", "whiteboard.storage_unavailable"],
          },
        },
        security: [
          {
            participantSyncBearer: [],
          },
        ],
        summary: "Finalize whiteboard file upload",
        "x-chalk-rate-limit": {
          limit: 60,
          name: "v1.authenticated.write",
          window_seconds: 60,
        },
      },
    },
    "/v1/whiteboard/files/{fileId}/download": {
      get: {
        operationId: "getWhiteboardFileDownload",
        parameters: [
          {
            in: "path",
            name: "fileId",
            required: true,
            schema: {
              maxLength: 128,
              minLength: 1,
              type: "string",
            },
          },
        ],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/WhiteboardFileDownload",
                },
              },
            },
            description: "OK",
          },
          400: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Request",
            "x-chalk-error-codes": ["whiteboard.invalid_file"],
          },
          401: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Unauthorized",
            "x-chalk-error-codes": ["access.unauthenticated"],
          },
          403: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Forbidden",
            "x-chalk-error-codes": ["access.forbidden"],
          },
          404: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Not Found",
            "x-chalk-error-codes": ["whiteboard.file_not_found", "whiteboard.upload_not_found"],
          },
          409: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Conflict",
            "x-chalk-error-codes": ["whiteboard.file_exists", "whiteboard.scene_changed", "whiteboard.upload_not_ready"],
          },
          410: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Gone",
            "x-chalk-error-codes": ["whiteboard.upload_expired"],
          },
          429: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Too Many Requests",
            headers: {
              "Retry-After": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Limit": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
              "X-RateLimit-Remaining": {
                required: true,
                schema: {
                  type: "integer",
                },
              },
            },
            "x-chalk-error-codes": ["request.rate_limited"],
          },
          502: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Bad Gateway",
            "x-chalk-error-codes": ["whiteboard.file_transfer_failed"],
          },
          503: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
            description: "Service Unavailable",
            "x-chalk-error-codes": ["service.unavailable", "whiteboard.storage_unavailable"],
          },
        },
        security: [
          {
            participantSyncBearer: [],
          },
        ],
        summary: "Get whiteboard file download",
      },
    },
  },
  components: {
    securitySchemes: {
      opsIngestToken: {
        description: "Private monitor-result ingestion token.",
        in: "header",
        name: "X-Ops-Ingest-Token",
        type: "apiKey",
      },
      participantMediaBearer: {
        bearerFormat: "JWT",
        description: "Short-lived participant media credential bound to one live participant generation and media-provider connection.",
        scheme: "bearer",
        type: "http",
      },
      participantSyncBearer: {
        bearerFormat: "JWT",
        description: "Short-lived Sync participant credential bound to one Space Episode and participant generation.",
        scheme: "bearer",
        type: "http",
      },
      sessionOrBearer: {
        description: "Preview placeholder for routes accepted by Chalk account auth or bearer/API-key auth.",
        scheme: "bearer",
        type: "http",
      },
    },
    schemas: {
      AIProviderConfig: {
        additionalProperties: true,
        properties: {
          allowed_models: {
            items: {
              minLength: 1,
              type: "string",
            },
            minItems: 1,
            type: "array",
          },
          api_key: {
            minLength: 1,
            type: "string",
          },
          base_url: {
            $ref: "#/components/schemas/URLString",
          },
          default_model: {
            minLength: 1,
            type: "string",
          },
          enabled: {
            type: "boolean",
          },
          fallback_model: {
            minLength: 1,
            type: "string",
          },
          mode: {
            enum: ["chalk_managed", "tenant_managed"],
            type: "string",
          },
          provider: {
            enum: ["openrouter"],
            type: "string",
          },
        },
        type: "object",
      },
      APIKeyList: {
        additionalProperties: false,
        properties: {
          api_keys: {
            items: {
              additionalProperties: false,
              properties: {
                created_at: {
                  $ref: "#/components/schemas/DateTimeString",
                },
                created_by_user_id: {
                  anyOf: [
                    {
                      $ref: "#/components/schemas/UserId",
                    },
                    {
                      type: "null",
                    },
                  ],
                },
                expires_at: {
                  $ref: "#/components/schemas/DateTimeString",
                },
                id: {
                  $ref: "#/components/schemas/UUID",
                },
                key_prefix: {
                  type: "string",
                },
                last_used_at: {
                  anyOf: [
                    {
                      $ref: "#/components/schemas/DateTimeString",
                    },
                    {
                      type: "null",
                    },
                  ],
                },
                name: {
                  type: "string",
                },
                revoked_at: {
                  anyOf: [
                    {
                      $ref: "#/components/schemas/DateTimeString",
                    },
                    {
                      type: "null",
                    },
                  ],
                },
                scopes: {
                  items: {
                    type: "string",
                  },
                  type: "array",
                },
                tenant_id: {
                  $ref: "#/components/schemas/TenantId",
                },
                updated_at: {
                  $ref: "#/components/schemas/DateTimeString",
                },
              },
              required: ["created_at", "created_by_user_id", "expires_at", "id", "key_prefix", "last_used_at", "name", "revoked_at", "scopes", "tenant_id", "updated_at"],
              type: "object",
            },
            type: "array",
          },
          pagination: {
            $ref: "#/components/schemas/Pagination",
          },
        },
        required: ["api_keys", "pagination"],
        type: "object",
      },
      APIKeyWithSecret: {
        additionalProperties: false,
        properties: {
          api_key: {
            additionalProperties: false,
            properties: {
              created_at: {
                $ref: "#/components/schemas/DateTimeString",
              },
              created_by_user_id: {
                anyOf: [
                  {
                    $ref: "#/components/schemas/UserId",
                  },
                  {
                    type: "null",
                  },
                ],
              },
              expires_at: {
                $ref: "#/components/schemas/DateTimeString",
              },
              id: {
                $ref: "#/components/schemas/UUID",
              },
              key_prefix: {
                type: "string",
              },
              last_used_at: {
                anyOf: [
                  {
                    $ref: "#/components/schemas/DateTimeString",
                  },
                  {
                    type: "null",
                  },
                ],
              },
              name: {
                type: "string",
              },
              revoked_at: {
                anyOf: [
                  {
                    $ref: "#/components/schemas/DateTimeString",
                  },
                  {
                    type: "null",
                  },
                ],
              },
              scopes: {
                items: {
                  type: "string",
                },
                type: "array",
              },
              tenant_id: {
                $ref: "#/components/schemas/TenantId",
              },
              updated_at: {
                $ref: "#/components/schemas/DateTimeString",
              },
            },
            required: ["created_at", "created_by_user_id", "expires_at", "id", "key_prefix", "last_used_at", "name", "revoked_at", "scopes", "tenant_id", "updated_at"],
            type: "object",
          },
          replayed: {
            type: "boolean",
          },
          secret: {
            type: "string",
          },
        },
        required: ["api_key", "replayed", "secret"],
        type: "object",
      },
      AccessGrant: {
        additionalProperties: false,
        properties: {
          diagnostics: {
            additionalProperties: false,
            properties: {
              expires_at: {
                $ref: "#/components/schemas/DateTimeString",
              },
              generation: {
                type: "integer",
              },
              intake_path: {
                type: "string",
              },
              token: {
                type: "string",
              },
            },
            required: ["expires_at", "generation", "intake_path", "token"],
            type: ["object", "null"],
          },
          media: {
            additionalProperties: false,
            properties: {
              client_payload: {
                additionalProperties: {
                  additionalProperties: true,
                  items: {},
                  type: ["object", "array", "string", "number", "boolean", "null"],
                },
                type: "object",
              },
              expires_at: {
                $ref: "#/components/schemas/DateTimeString",
              },
              provider: {
                type: "string",
              },
              token: {
                type: "string",
              },
            },
            required: ["client_payload", "expires_at", "provider", "token"],
            type: "object",
          },
          subject: {
            additionalProperties: false,
            properties: {
              episode_id: {
                $ref: "#/components/schemas/EpisodeId",
              },
              participant_generation: {
                type: "integer",
              },
              participant_id: {
                $ref: "#/components/schemas/ParticipantId",
              },
              space_id: {
                $ref: "#/components/schemas/SpaceId",
              },
              tenant_id: {
                $ref: "#/components/schemas/TenantId",
              },
            },
            required: ["episode_id", "participant_generation", "participant_id", "space_id", "tenant_id"],
            type: "object",
          },
          sync: {
            additionalProperties: false,
            properties: {
              expires_at: {
                $ref: "#/components/schemas/DateTimeString",
              },
              token: {
                type: "string",
              },
            },
            required: ["expires_at", "token"],
            type: "object",
          },
        },
        required: ["media", "subject", "sync"],
        type: "object",
      },
      AccountTenantList: {
        additionalProperties: false,
        properties: {
          pagination: {
            $ref: "#/components/schemas/Pagination",
          },
          tenants: {
            items: {
              additionalProperties: false,
              properties: {
                access: {
                  additionalProperties: false,
                  properties: {
                    account_id: {
                      $ref: "#/components/schemas/UUID",
                    },
                    created_at: {
                      $ref: "#/components/schemas/DateTimeString",
                    },
                    id: {
                      $ref: "#/components/schemas/UUID",
                    },
                    role: {
                      type: "string",
                    },
                    tenant_id: {
                      $ref: "#/components/schemas/TenantId",
                    },
                    updated_at: {
                      $ref: "#/components/schemas/DateTimeString",
                    },
                  },
                  required: ["account_id", "created_at", "id", "role", "tenant_id", "updated_at"],
                  type: "object",
                },
                tenant: {
                  $ref: "#/components/schemas/Tenant",
                },
              },
              required: ["access", "tenant"],
              type: "object",
            },
            type: "array",
          },
        },
        required: ["pagination", "tenants"],
        type: "object",
      },
      AccountTenantOnboardingResponse: {
        additionalProperties: false,
        properties: {
          access: {
            additionalProperties: false,
            properties: {
              account_id: {
                $ref: "#/components/schemas/UUID",
              },
              created_at: {
                $ref: "#/components/schemas/DateTimeString",
              },
              id: {
                $ref: "#/components/schemas/UUID",
              },
              role: {
                type: "string",
              },
              tenant_id: {
                $ref: "#/components/schemas/TenantId",
              },
              updated_at: {
                $ref: "#/components/schemas/DateTimeString",
              },
            },
            required: ["account_id", "created_at", "id", "role", "tenant_id", "updated_at"],
            type: "object",
          },
          replayed: {
            type: "boolean",
          },
          tenant: {
            $ref: "#/components/schemas/Tenant",
          },
        },
        required: ["access", "replayed", "tenant"],
        type: "object",
      },
      AdmitEpisodeParticipantRequest: {
        additionalProperties: false,
        properties: {
          identity_id: {
            $ref: "#/components/schemas/UUID",
          },
          metadata: {
            additionalProperties: true,
            items: {},
            type: ["object", "array", "string", "number", "boolean", "null"],
          },
          name: {
            minLength: 1,
            type: "string",
          },
          participant_id: {
            $ref: "#/components/schemas/ParticipantId",
          },
          role: {
            minLength: 1,
            type: "string",
          },
        },
        required: ["name", "role"],
        type: "object",
      },
      AuditLog: {
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
          },
          actor_type: {
            type: "string",
          },
          actor_user_id: {
            anyOf: [
              {
                $ref: "#/components/schemas/UserId",
              },
              {
                type: "null",
              },
            ],
          },
          after: {
            additionalProperties: true,
            items: {},
            type: ["object", "array", "string", "number", "boolean", "null"],
          },
          before: {
            additionalProperties: true,
            items: {},
            type: ["object", "array", "string", "number", "boolean", "null"],
          },
          created_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          details: {
            additionalProperties: true,
            items: {},
            type: ["object", "array", "string", "number", "boolean", "null"],
          },
          error_code: {
            type: ["string", "null"],
          },
          error_message: {
            type: ["string", "null"],
          },
          id: {
            $ref: "#/components/schemas/AuditLogId",
          },
          outcome: {
            type: "string",
          },
          resource_id: {
            anyOf: [
              {
                $ref: "#/components/schemas/UUID",
              },
              {
                type: "null",
              },
            ],
          },
          resource_type: {
            type: ["string", "null"],
          },
          tenant_id: {
            $ref: "#/components/schemas/TenantId",
          },
          updated_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
        },
        required: ["action", "actor_type", "actor_user_id", "after", "before", "created_at", "details", "error_code", "error_message", "id", "outcome", "resource_id", "resource_type", "tenant_id", "updated_at"],
        type: "object",
      },
      AuditLogId: {
        format: "uuid",
        maxLength: 36,
        minLength: 36,
        type: "string",
        "x-chalk-brand": "AuditLogId",
      },
      AuditLogList: {
        additionalProperties: false,
        properties: {
          audit_logs: {
            items: {
              $ref: "#/components/schemas/AuditLog",
            },
            type: "array",
          },
          pagination: {
            $ref: "#/components/schemas/Pagination",
          },
        },
        required: ["audit_logs", "pagination"],
        type: "object",
      },
      Auth: {
        additionalProperties: false,
        properties: {
          expires_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          session_token: {
            type: "string",
          },
          user: {
            $ref: "#/components/schemas/AuthUser",
          },
        },
        required: ["expires_at", "session_token", "user"],
        type: "object",
      },
      AuthUser: {
        additionalProperties: false,
        properties: {
          created_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          email: {
            $ref: "#/components/schemas/Email",
          },
          id: {
            $ref: "#/components/schemas/UserId",
          },
          name: {
            type: "string",
          },
          updated_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
        },
        required: ["created_at", "email", "id", "name", "updated_at"],
        type: "object",
      },
      ChatAttachment: {
        additionalProperties: false,
        properties: {
          attachmentId: {
            type: "string",
          },
          byteLength: {
            type: "integer",
          },
          fileName: {
            type: "string",
          },
          mimeType: {
            type: "string",
          },
        },
        required: ["attachmentId", "byteLength", "fileName", "mimeType"],
        type: "object",
      },
      ChatAttachmentDownload: {
        additionalProperties: false,
        properties: {
          downloadUrl: {
            type: "string",
          },
          expiresAt: {
            type: "string",
          },
        },
        required: ["downloadUrl", "expiresAt"],
        type: "object",
      },
      ChatAttachmentUpload: {
        additionalProperties: false,
        properties: {
          attachmentId: {
            type: "string",
          },
          expiresAt: {
            type: "string",
          },
          headers: {
            additionalProperties: {
              type: "string",
            },
            type: "object",
          },
          method: {
            type: "string",
          },
          uploadId: {
            type: "string",
          },
          uploadUrl: {
            type: "string",
          },
        },
        required: ["attachmentId", "expiresAt", "headers", "method", "uploadId", "uploadUrl"],
        type: "object",
      },
      CloudflareSFUCloseTracksAPIResponse: {
        additionalProperties: false,
        properties: {
          requiresImmediateRenegotiation: {
            type: "boolean",
          },
          sessionDescription: {
            additionalProperties: false,
            properties: {
              sdp: {
                type: "string",
              },
              type: {
                type: "string",
              },
            },
            required: ["sdp", "type"],
            type: ["object", "null"],
          },
          tracks: {
            items: {
              additionalProperties: false,
              properties: {
                mid: {
                  type: "string",
                },
                publication_id: {
                  type: "string",
                },
                source: {
                  type: "string",
                },
              },
              required: ["mid", "publication_id", "source"],
              type: "object",
            },
            type: "array",
          },
        },
        type: "object",
      },
      CloudflareSFUCloseTracksRequest: {
        additionalProperties: false,
        properties: {
          connection_id: {
            minLength: 1,
            type: "string",
          },
          force: {
            type: "boolean",
          },
          session_description: {
            additionalProperties: false,
            properties: {
              sdp: {
                minLength: 1,
                type: "string",
              },
              type: {
                minLength: 1,
                type: "string",
              },
            },
            required: ["sdp", "type"],
            type: ["object", "null"],
          },
          tracks: {
            items: {
              additionalProperties: false,
              properties: {
                mid: {
                  minLength: 1,
                  type: "string",
                },
                publication_id: {
                  minLength: 1,
                  type: "string",
                },
                source: {
                  minLength: 1,
                  type: "string",
                },
              },
              required: ["mid", "publication_id", "source"],
              type: "object",
            },
            type: "array",
          },
        },
        required: ["connection_id", "force", "tracks"],
        type: "object",
      },
      CloudflareSFUPublicationsResponse: {
        additionalProperties: false,
        properties: {
          incarnation: {
            type: "integer",
          },
          publications: {
            items: {
              additionalProperties: false,
              properties: {
                participant_id: {
                  $ref: "#/components/schemas/ParticipantId",
                },
                publication_id: {
                  type: "string",
                },
                source: {
                  type: "string",
                },
              },
              required: ["participant_id", "publication_id", "source"],
              type: "object",
            },
            type: "array",
          },
          sequence: {
            type: "integer",
          },
        },
        required: ["incarnation", "publications", "sequence"],
        type: "object",
      },
      CloudflareSFURenegotiateRequest: {
        additionalProperties: false,
        properties: {
          connection_id: {
            minLength: 1,
            type: "string",
          },
          session_description: {
            additionalProperties: false,
            properties: {
              sdp: {
                minLength: 1,
                type: "string",
              },
              type: {
                minLength: 1,
                type: "string",
              },
            },
            required: ["sdp", "type"],
            type: "object",
          },
        },
        required: ["connection_id", "session_description"],
        type: "object",
      },
      CloudflareSFURenegotiateResponse: {
        additionalProperties: false,
        properties: {
          accepted: {
            type: "boolean",
          },
        },
        required: ["accepted"],
        type: "object",
      },
      CloudflareSFUTracksAPIResponse: {
        additionalProperties: false,
        properties: {
          requiresImmediateRenegotiation: {
            type: "boolean",
          },
          sessionDescription: {
            additionalProperties: false,
            properties: {
              sdp: {
                type: "string",
              },
              type: {
                type: "string",
              },
            },
            required: ["sdp", "type"],
            type: ["object", "null"],
          },
          tracks: {
            items: {
              additionalProperties: false,
              properties: {
                location: {
                  type: "string",
                },
                mid: {
                  type: "string",
                },
                publication_id: {
                  type: "string",
                },
                sessionId: {
                  type: "string",
                },
                source: {
                  type: "string",
                },
                trackName: {
                  type: "string",
                },
              },
              required: ["location", "trackName"],
              type: "object",
            },
            type: "array",
          },
        },
        type: "object",
      },
      CloudflareSFUTracksRequest: {
        additionalProperties: false,
        properties: {
          connection_id: {
            minLength: 1,
            type: "string",
          },
          session_description: {
            additionalProperties: false,
            properties: {
              sdp: {
                minLength: 1,
                type: "string",
              },
              type: {
                minLength: 1,
                type: "string",
              },
            },
            required: ["sdp", "type"],
            type: ["object", "null"],
          },
          tracks: {
            items: {
              additionalProperties: false,
              properties: {
                location: {
                  minLength: 1,
                  type: "string",
                },
                mid: {
                  minLength: 1,
                  type: "string",
                },
                publication_id: {
                  minLength: 1,
                  type: "string",
                },
                sessionId: {
                  minLength: 1,
                  type: "string",
                },
                source: {
                  minLength: 1,
                  type: "string",
                },
                trackName: {
                  minLength: 1,
                  type: "string",
                },
              },
              required: ["location", "trackName"],
              type: "object",
            },
            type: "array",
          },
        },
        required: ["connection_id", "tracks"],
        type: "object",
      },
      CreateAPIKeyRequest: {
        additionalProperties: false,
        properties: {
          expires_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          name: {
            minLength: 1,
            type: "string",
          },
          scopes: {
            items: {
              type: "string",
            },
            type: "array",
          },
        },
        required: ["expires_at", "name", "scopes"],
        type: "object",
      },
      CreateEpisodeRequest: {
        additionalProperties: false,
        properties: {
          metadata: {
            additionalProperties: true,
            items: {},
            type: ["object", "array", "string", "number", "boolean", "null"],
          },
          started_at: {
            anyOf: [
              {
                $ref: "#/components/schemas/DateTimeString",
              },
              {
                type: "null",
              },
            ],
          },
        },
        type: "object",
      },
      CreateMembershipRequest: {
        additionalProperties: false,
        properties: {
          role: {
            enum: ["owner", "collaborator", "observer"],
            type: "string",
          },
          user_id: {
            $ref: "#/components/schemas/UserId",
          },
        },
        required: ["role", "user_id"],
        type: "object",
      },
      CreatePublicSpaceRequest: {
        additionalProperties: false,
        properties: {
          display_name: {
            minLength: 1,
            type: "string",
          },
        },
        required: ["display_name"],
        type: "object",
      },
      CreateRecordingDownloadURLRequest: {
        additionalProperties: false,
        properties: {
          expires_in_seconds: {
            type: "integer",
          },
        },
        required: ["expires_in_seconds"],
        type: "object",
      },
      CreateRecordingRequest: {
        additionalProperties: false,
        properties: {
          metadata: {
            additionalProperties: true,
            items: {},
            type: ["object", "array", "string", "number", "boolean", "null"],
          },
          status: {
            enum: ["pending", "processing", "completed", "failed"],
            type: "string",
          },
          storage_key: {
            minLength: 1,
            type: ["string", "null"],
          },
          storage_provider: {
            enum: ["r2"],
            type: "string",
          },
        },
        required: ["status", "storage_provider"],
        type: "object",
      },
      CreateRecordingReservationRequest: {
        additionalProperties: false,
        properties: {
          input_bitrate_bps: {
            type: "integer",
          },
          max_duration_minutes: {
            type: "integer",
          },
          participant_count: {
            type: "integer",
          },
          scheduled_start: {
            minLength: 1,
            type: ["string", "null"],
          },
        },
        required: ["input_bitrate_bps", "max_duration_minutes", "participant_count"],
        type: "object",
      },
      CreateSpaceRequest: {
        additionalProperties: false,
        properties: {
          admission_policy: {
            additionalProperties: true,
            items: {},
            type: ["object", "array", "string", "number", "boolean", "null"],
          },
          default_episode_duration_seconds: {
            type: "integer",
          },
          linger_window_seconds: {
            type: "integer",
          },
          maximum_episode_duration_seconds: {
            type: "integer",
          },
          media_plane: {
            minLength: 1,
            type: "string",
          },
          metadata: {
            additionalProperties: true,
            items: {},
            type: ["object", "array", "string", "number", "boolean", "null"],
          },
          name: {
            minLength: 1,
            type: "string",
          },
          recurring_policy: {
            additionalProperties: true,
            items: {},
            type: ["object", "array", "string", "number", "boolean", "null"],
          },
          slug: {
            minLength: 1,
            type: "string",
          },
        },
        required: ["default_episode_duration_seconds", "linger_window_seconds", "maximum_episode_duration_seconds", "name", "slug"],
        type: "object",
      },
      CreateTenantRequest: {
        additionalProperties: false,
        properties: {
          ai_provider_config: {
            anyOf: [
              {
                $ref: "#/components/schemas/AIProviderConfig",
              },
              {
                type: "null",
              },
            ],
          },
          default_media_plane: {
            minLength: 1,
            type: ["string", "null"],
          },
          default_region: {
            minLength: 1,
            type: ["string", "null"],
          },
          logo_key: {
            minLength: 1,
            type: ["string", "null"],
          },
          media_plane_provider_config: {
            anyOf: [
              {
                $ref: "#/components/schemas/MediaPlaneProviderConfig",
              },
              {
                type: "null",
              },
            ],
          },
          name: {
            minLength: 1,
            type: "string",
          },
          storage_provider_config: {
            anyOf: [
              {
                $ref: "#/components/schemas/StorageProviderConfig",
              },
              {
                type: "null",
              },
            ],
          },
          website: {
            anyOf: [
              {
                $ref: "#/components/schemas/URLString",
              },
              {
                type: "null",
              },
            ],
          },
        },
        required: ["name"],
        type: "object",
      },
      CreateTranscriptDownloadURLRequest: {
        additionalProperties: false,
        properties: {
          expires_in_seconds: {
            type: "integer",
          },
        },
        required: ["expires_in_seconds"],
        type: "object",
      },
      CreateUserRequest: {
        additionalProperties: false,
        properties: {
          email: {
            $ref: "#/components/schemas/Email",
          },
          name: {
            minLength: 1,
            type: "string",
          },
        },
        required: ["email", "name"],
        type: "object",
      },
      CreateWebhookEndpointRequest: {
        additionalProperties: false,
        properties: {
          api_version: {
            type: "integer",
          },
          enabled: {
            type: "boolean",
          },
          event_types: {
            items: {
              type: "string",
            },
            type: "array",
          },
          name: {
            minLength: 1,
            type: "string",
          },
          url: {
            minLength: 1,
            type: "string",
          },
        },
        required: ["api_version", "enabled", "event_types", "name", "url"],
        type: "object",
      },
      DashboardSpaceSelfJoinRequest: {
        additionalProperties: false,
        properties: {
          display_name: {
            minLength: 1,
            type: "string",
          },
        },
        required: ["display_name"],
        type: "object",
      },
      DateTimeString: {
        format: "date-time",
        type: "string",
        "x-chalk-brand": "DateTimeString",
      },
      Email: {
        format: "email",
        type: "string",
        "x-chalk-brand": "Email",
      },
      Episode: {
        additionalProperties: false,
        properties: {
          config_snapshot: {
            additionalProperties: true,
            items: {},
            type: ["object", "array", "string", "number", "boolean", "null"],
          },
          created_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          deadline_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          deadline_generation: {
            type: "integer",
          },
          end_reason: {
            type: ["string", "null"],
          },
          ended_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          id: {
            $ref: "#/components/schemas/EpisodeId",
          },
          metadata: {
            additionalProperties: true,
            items: {},
            type: ["object", "array", "string", "number", "boolean", "null"],
          },
          space_id: {
            $ref: "#/components/schemas/SpaceId",
          },
          started_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          status: {
            enum: ["active", "ending", "ended"],
            type: "string",
          },
          tenant_id: {
            $ref: "#/components/schemas/TenantId",
          },
          updated_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
        },
        required: ["config_snapshot", "created_at", "deadline_at", "deadline_generation", "id", "metadata", "space_id", "started_at", "status", "tenant_id", "updated_at"],
        type: "object",
      },
      EpisodeDeadline: {
        $ref: "#/components/schemas/EpisodeEnd",
      },
      EpisodeEnd: {
        additionalProperties: false,
        properties: {
          episode_id: {
            $ref: "#/components/schemas/EpisodeId",
          },
          external_operation: {
            additionalProperties: false,
            properties: {
              created_at: {
                $ref: "#/components/schemas/DateTimeString",
              },
              deadline_generation: {
                type: ["integer", "null"],
              },
              id: {
                $ref: "#/components/schemas/UUID",
              },
              operation_name: {
                type: "string",
              },
              request_key: {
                type: "string",
              },
              status: {
                type: "string",
              },
              target_participant_generation: {
                type: ["integer", "null"],
              },
              target_participant_id: {
                anyOf: [
                  {
                    $ref: "#/components/schemas/ParticipantId",
                  },
                  {
                    type: "null",
                  },
                ],
              },
            },
            required: ["created_at", "id", "operation_name", "request_key", "status"],
            type: "object",
          },
          status: {
            type: "string",
          },
        },
        required: ["episode_id", "external_operation", "status"],
        type: "object",
      },
      EpisodeId: {
        format: "uuid",
        maxLength: 36,
        minLength: 36,
        type: "string",
        "x-chalk-brand": "EpisodeId",
      },
      EpisodeList: {
        additionalProperties: false,
        properties: {
          episodes: {
            items: {
              $ref: "#/components/schemas/Episode",
            },
            type: "array",
          },
          pagination: {
            $ref: "#/components/schemas/Pagination",
          },
        },
        required: ["episodes", "pagination"],
        type: "object",
      },
      ErrorResponse: {
        additionalProperties: false,
        properties: {
          error: {
            additionalProperties: false,
            properties: {
              code: {
                type: "string",
              },
              message: {
                type: "string",
              },
            },
            required: ["code", "message"],
            type: "object",
          },
        },
        required: ["error"],
        type: "object",
      },
      ExecuteIntegrationActionRequest: {
        additionalProperties: false,
        properties: {
          action: {
            minLength: 1,
            type: "string",
          },
          arguments: {
            additionalProperties: {
              additionalProperties: true,
              items: {},
              type: ["object", "array", "string", "number", "boolean", "null"],
            },
            type: ["object", "null"],
          },
          text: {
            minLength: 1,
            type: ["string", "null"],
          },
        },
        required: ["action"],
        type: "object",
      },
      ExtendRecordingReservationRequest: {
        additionalProperties: false,
        properties: {
          max_duration_minutes: {
            type: "integer",
          },
        },
        required: ["max_duration_minutes"],
        type: "object",
      },
      InitiateChatAttachmentUploadRequest: {
        additionalProperties: false,
        properties: {
          byteLength: {
            type: "integer",
          },
          clientAttachmentId: {
            minLength: 1,
            type: "string",
          },
          fileName: {
            minLength: 1,
            type: "string",
          },
          mimeType: {
            minLength: 1,
            type: "string",
          },
          sha256: {
            minLength: 1,
            type: "string",
          },
        },
        required: ["byteLength", "clientAttachmentId", "fileName", "mimeType", "sha256"],
        type: "object",
      },
      InitiateWhiteboardFileUploadRequest: {
        additionalProperties: false,
        properties: {
          byteLength: {
            type: "integer",
          },
          fileId: {
            minLength: 1,
            type: "string",
          },
          mimeType: {
            minLength: 1,
            type: "string",
          },
          sceneId: {
            minLength: 1,
            type: "string",
          },
          sha256: {
            minLength: 1,
            type: "string",
          },
        },
        required: ["byteLength", "fileId", "mimeType", "sceneId", "sha256"],
        type: "object",
      },
      IntegrationActionExecution: {
        additionalProperties: false,
        properties: {
          action: {
            additionalProperties: false,
            properties: {
              capability_tags: {
                items: {
                  type: "string",
                },
                type: "array",
              },
              display_name: {
                type: "string",
              },
              id: {
                $ref: "#/components/schemas/IntegrationActionId",
              },
              risk_tags: {
                items: {
                  type: "string",
                },
                type: "array",
              },
            },
            required: ["capability_tags", "display_name", "id", "risk_tags"],
            type: "object",
          },
          connection: {
            $ref: "#/components/schemas/IntegrationConnection",
          },
          data: {
            additionalProperties: {
              additionalProperties: true,
              items: {},
              type: ["object", "array", "string", "number", "boolean", "null"],
            },
            type: "object",
          },
          log_id: {
            $ref: "#/components/schemas/UUID",
          },
        },
        required: ["action", "connection", "data"],
        type: "object",
      },
      IntegrationActionId: {
        minLength: 1,
        type: "string",
        "x-chalk-brand": "IntegrationActionId",
      },
      IntegrationConnection: {
        additionalProperties: false,
        properties: {
          account_email: {
            type: ["string", "null"],
          },
          account_label: {
            type: ["string", "null"],
          },
          connected_at: {
            anyOf: [
              {
                $ref: "#/components/schemas/DateTimeString",
              },
              {
                type: "null",
              },
            ],
          },
          created_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          expires_at: {
            anyOf: [
              {
                $ref: "#/components/schemas/DateTimeString",
              },
              {
                type: "null",
              },
            ],
          },
          id: {
            $ref: "#/components/schemas/UUID",
          },
          last_used_at: {
            anyOf: [
              {
                $ref: "#/components/schemas/DateTimeString",
              },
              {
                type: "null",
              },
            ],
          },
          provider: {
            type: "string",
          },
          revoked_at: {
            anyOf: [
              {
                $ref: "#/components/schemas/DateTimeString",
              },
              {
                type: "null",
              },
            ],
          },
          scopes: {
            items: {
              type: "string",
            },
            type: "array",
          },
          service: {
            type: "string",
          },
          status: {
            type: "string",
          },
          tenant_id: {
            $ref: "#/components/schemas/TenantId",
          },
          updated_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          user_id: {
            $ref: "#/components/schemas/UserId",
          },
        },
        required: ["account_email", "account_label", "connected_at", "created_at", "expires_at", "id", "last_used_at", "provider", "revoked_at", "scopes", "service", "status", "tenant_id", "updated_at", "user_id"],
        type: "object",
      },
      IntegrationConnectionList: {
        additionalProperties: false,
        properties: {
          connections: {
            items: {
              $ref: "#/components/schemas/IntegrationConnection",
            },
            type: "array",
          },
          pagination: {
            $ref: "#/components/schemas/Pagination",
          },
        },
        required: ["connections", "pagination"],
        type: "object",
      },
      IntegrationConnectionRefresh: {
        additionalProperties: false,
        properties: {
          connect_url: {
            anyOf: [
              {
                $ref: "#/components/schemas/URLString",
              },
              {
                type: "null",
              },
            ],
          },
          connection: {
            $ref: "#/components/schemas/IntegrationConnection",
          },
        },
        required: ["connection"],
        type: "object",
      },
      IntegrationConnectionStart: {
        additionalProperties: false,
        properties: {
          connect_url: {
            $ref: "#/components/schemas/URLString",
          },
          connection: {
            $ref: "#/components/schemas/IntegrationConnection",
          },
          expires_at: {
            anyOf: [
              {
                $ref: "#/components/schemas/DateTimeString",
              },
              {
                type: "null",
              },
            ],
          },
        },
        required: ["connect_url", "connection", "expires_at"],
        type: "object",
      },
      IntegrationServiceId: {
        minLength: 1,
        type: "string",
        "x-chalk-brand": "IntegrationServiceId",
      },
      IntegrationServices: {
        additionalProperties: false,
        properties: {
          families: {
            items: {
              additionalProperties: false,
              properties: {
                name: {
                  type: "string",
                },
                services: {
                  items: {
                    additionalProperties: false,
                    properties: {
                      actions: {
                        items: {
                          additionalProperties: false,
                          properties: {
                            capability_tags: {
                              items: {
                                type: "string",
                              },
                              type: "array",
                            },
                            display_name: {
                              type: "string",
                            },
                            id: {
                              $ref: "#/components/schemas/IntegrationActionId",
                            },
                            risk_tags: {
                              items: {
                                type: "string",
                              },
                              type: "array",
                            },
                          },
                          required: ["capability_tags", "display_name", "id", "risk_tags"],
                          type: "object",
                        },
                        type: "array",
                      },
                      capability_tags: {
                        items: {
                          type: "string",
                        },
                        type: "array",
                      },
                      display_name: {
                        type: "string",
                      },
                      family: {
                        type: "string",
                      },
                      id: {
                        $ref: "#/components/schemas/IntegrationServiceId",
                      },
                      provider: {
                        type: "string",
                      },
                      risk_tags: {
                        items: {
                          type: "string",
                        },
                        type: "array",
                      },
                    },
                    required: ["actions", "capability_tags", "display_name", "family", "id", "provider", "risk_tags"],
                    type: "object",
                  },
                  type: "array",
                },
              },
              required: ["name", "services"],
              type: "object",
            },
            type: "array",
          },
        },
        required: ["families"],
        type: "object",
      },
      IssueAccessGrantRequest: {
        additionalProperties: false,
        properties: {
          current_media_token: {
            minLength: 1,
            type: "string",
          },
          participant_generation: {
            type: "integer",
          },
          replace_media_connection: {
            type: "boolean",
          },
        },
        required: ["participant_generation", "replace_media_connection"],
        type: "object",
      },
      JourneyEventBatch: {
        additionalProperties: false,
        properties: {
          events: {
            items: {
              additionalProperties: false,
              properties: {
                attributes: {
                  additionalProperties: {
                    anyOf: [
                      {
                        maxLength: 1024,
                        type: "string",
                      },
                      {
                        type: "number",
                      },
                      {
                        type: "boolean",
                      },
                    ],
                  },
                  maxProperties: 32,
                  type: "object",
                },
                event_id: {
                  $ref: "#/components/schemas/UUID",
                },
                first_observed_layer: {
                  minLength: 1,
                  type: "string",
                },
                journey_id: {
                  $ref: "#/components/schemas/UUID",
                },
                name: {
                  minLength: 1,
                  type: "string",
                },
                occurred_at: {
                  $ref: "#/components/schemas/DateTimeString",
                },
                origin_kind: {
                  minLength: 1,
                  type: "string",
                },
                parent_event_id: {
                  anyOf: [
                    {
                      $ref: "#/components/schemas/UUID",
                    },
                    {
                      type: "null",
                    },
                  ],
                },
                phase: {
                  minLength: 1,
                  type: "string",
                },
                sequence: {
                  type: "integer",
                },
                span_id: {
                  maxLength: 16,
                  minLength: 16,
                  pattern: "^(?=.*[1-9a-fA-F])[0-9a-fA-F]{16}$",
                  type: ["string", "null"],
                },
                state: {
                  minLength: 1,
                  type: "string",
                },
                trace_id: {
                  maxLength: 32,
                  minLength: 32,
                  pattern: "^(?=.*[1-9a-fA-F])[0-9a-fA-F]{32}$",
                  type: ["string", "null"],
                },
                upstream_visibility: {
                  minLength: 1,
                  type: "string",
                },
              },
              required: ["event_id", "first_observed_layer", "journey_id", "name", "occurred_at", "origin_kind", "phase", "sequence", "state", "upstream_visibility"],
              type: "object",
            },
            maxItems: 100,
            type: "array",
          },
        },
        required: ["events"],
        type: "object",
      },
      JourneyEventIntake: {
        additionalProperties: false,
        properties: {
          accepted_count: {
            type: "integer",
          },
          duplicate_count: {
            type: "integer",
          },
          journey_ids: {
            items: {
              type: "string",
            },
            type: "array",
          },
        },
        required: ["accepted_count", "duplicate_count", "journey_ids"],
        type: "object",
      },
      LeaveDashboardSpaceSelfRequest: {
        additionalProperties: false,
        properties: {
          participant_generation: {
            type: "integer",
          },
        },
        required: ["participant_generation"],
        type: "object",
      },
      LoginRequest: {
        additionalProperties: false,
        properties: {
          email: {
            $ref: "#/components/schemas/Email",
          },
          password: {
            minLength: 1,
            type: "string",
          },
        },
        required: ["email", "password"],
        type: "object",
      },
      MediaPlaneProviderConfig: {
        additionalProperties: true,
        description: "Provider-specific properties are opaque to this API contract. The server's media-plane adapter for the named provider validates them, and secret values are redacted in API responses.",
        properties: {
          enabled: {
            type: "boolean",
          },
          mode: {
            enum: ["chalk_managed", "tenant_managed"],
            type: "string",
          },
          provider: {
            description: "Known values include cf_sfu and cf_rtk.",
            type: "string",
          },
        },
        type: "object",
      },
      Membership: {
        additionalProperties: false,
        properties: {
          created_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          id: {
            $ref: "#/components/schemas/MembershipId",
          },
          role: {
            enum: ["owner", "collaborator", "observer"],
            type: "string",
          },
          tenant_id: {
            $ref: "#/components/schemas/TenantId",
          },
          updated_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          user_id: {
            $ref: "#/components/schemas/UserId",
          },
        },
        required: ["created_at", "id", "role", "tenant_id", "updated_at", "user_id"],
        type: "object",
      },
      MembershipId: {
        format: "uuid",
        maxLength: 36,
        minLength: 36,
        type: "string",
        "x-chalk-brand": "MembershipId",
      },
      MembershipList: {
        additionalProperties: false,
        properties: {
          memberships: {
            items: {
              $ref: "#/components/schemas/Membership",
            },
            type: "array",
          },
          pagination: {
            $ref: "#/components/schemas/Pagination",
          },
        },
        required: ["memberships", "pagination"],
        type: "object",
      },
      OnboardTenantRequest: {
        additionalProperties: false,
        properties: {
          default_region: {
            minLength: 1,
            type: ["string", "null"],
          },
          name: {
            minLength: 1,
            type: "string",
          },
        },
        required: ["name"],
        type: "object",
      },
      Pagination: {
        additionalProperties: false,
        properties: {
          has_more: {
            type: "boolean",
          },
          next_cursor: {
            type: ["string", "null"],
          },
          page_size: {
            type: "integer",
          },
        },
        required: ["has_more", "next_cursor", "page_size"],
        type: "object",
      },
      ParticipantId: {
        format: "uuid",
        maxLength: 36,
        minLength: 36,
        type: "string",
        "x-chalk-brand": "ParticipantId",
      },
      ParticipantLifecycle: {
        additionalProperties: false,
        properties: {
          access: {
            anyOf: [
              {
                $ref: "#/components/schemas/AccessGrant",
              },
              {
                type: "null",
              },
            ],
          },
          admission_request: {
            additionalProperties: false,
            properties: {
              expires_at: {
                $ref: "#/components/schemas/DateTimeString",
              },
              id: {
                $ref: "#/components/schemas/ParticipantId",
              },
              status: {
                type: "string",
              },
            },
            required: ["expires_at", "id", "status"],
            type: ["object", "null"],
          },
          expires_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          lifecycle_intent: {
            additionalProperties: false,
            properties: {
              created_at: {
                $ref: "#/components/schemas/DateTimeString",
              },
              id: {
                $ref: "#/components/schemas/ParticipantId",
              },
              intent_name: {
                type: "string",
              },
              participant_generation: {
                type: ["integer", "null"],
              },
              participant_id: {
                anyOf: [
                  {
                    $ref: "#/components/schemas/ParticipantId",
                  },
                  {
                    type: "null",
                  },
                ],
              },
              request_key: {
                type: "string",
              },
              status: {
                type: "string",
              },
            },
            required: ["created_at", "id", "intent_name", "request_key", "status"],
            type: "object",
          },
          media_plane: {
            additionalProperties: false,
            properties: {
              client_payload: {
                additionalProperties: {
                  additionalProperties: true,
                  items: {},
                  type: ["object", "array", "string", "number", "boolean", "null"],
                },
                type: "object",
              },
              provider: {
                type: "string",
              },
            },
            required: ["client_payload", "provider"],
            type: ["object", "null"],
          },
          participant: {
            additionalProperties: false,
            properties: {
              capabilities: {
                items: {
                  type: "string",
                },
                type: "array",
              },
              episode_id: {
                $ref: "#/components/schemas/EpisodeId",
              },
              generation: {
                type: "integer",
              },
              id: {
                $ref: "#/components/schemas/ParticipantId",
              },
              identity_id: {
                anyOf: [
                  {
                    $ref: "#/components/schemas/UUID",
                  },
                  {
                    type: "null",
                  },
                ],
              },
              role: {
                type: "string",
              },
              space_id: {
                $ref: "#/components/schemas/SpaceId",
              },
              status: {
                type: "string",
              },
              tenant_id: {
                $ref: "#/components/schemas/TenantId",
              },
            },
            required: ["capabilities", "episode_id", "generation", "id", "role", "space_id", "status", "tenant_id"],
            type: "object",
          },
          sync_token: {
            type: "string",
          },
        },
        required: ["lifecycle_intent", "participant"],
        type: "object",
      },
      ParticipantRemoval: {
        additionalProperties: false,
        properties: {
          external_operation: {
            additionalProperties: false,
            properties: {
              created_at: {
                $ref: "#/components/schemas/DateTimeString",
              },
              deadline_generation: {
                type: ["integer", "null"],
              },
              id: {
                $ref: "#/components/schemas/UUID",
              },
              operation_name: {
                type: "string",
              },
              request_key: {
                type: "string",
              },
              status: {
                type: "string",
              },
              target_participant_generation: {
                type: ["integer", "null"],
              },
              target_participant_id: {
                anyOf: [
                  {
                    $ref: "#/components/schemas/ParticipantId",
                  },
                  {
                    type: "null",
                  },
                ],
              },
            },
            required: ["created_at", "id", "operation_name", "request_key", "status"],
            type: "object",
          },
          participant: {
            additionalProperties: false,
            properties: {
              capabilities: {
                items: {
                  type: "string",
                },
                type: "array",
              },
              episode_id: {
                $ref: "#/components/schemas/EpisodeId",
              },
              generation: {
                type: "integer",
              },
              id: {
                $ref: "#/components/schemas/UUID",
              },
              identity_id: {
                anyOf: [
                  {
                    $ref: "#/components/schemas/UUID",
                  },
                  {
                    type: "null",
                  },
                ],
              },
              role: {
                type: "string",
              },
              space_id: {
                $ref: "#/components/schemas/SpaceId",
              },
              status: {
                type: "string",
              },
              tenant_id: {
                $ref: "#/components/schemas/TenantId",
              },
            },
            required: ["capabilities", "episode_id", "generation", "id", "role", "space_id", "status", "tenant_id"],
            type: "object",
          },
        },
        required: ["external_operation", "participant"],
        type: "object",
      },
      PublicAdmissionRequest: {
        additionalProperties: false,
        properties: {
          display_name: {
            type: "string",
          },
          expires_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          request_handle: {
            type: "string",
          },
          requested_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          state: {
            type: "string",
          },
        },
        required: ["display_name", "expires_at", "request_handle", "requested_at", "state"],
        type: "object",
      },
      PublicAdmissionRequestPage: {
        additionalProperties: false,
        properties: {
          requests: {
            items: {
              $ref: "#/components/schemas/PublicAdmissionRequest",
            },
            type: "array",
          },
        },
        required: ["requests"],
        type: "object",
      },
      PublicSpaceArrival: {
        additionalProperties: false,
        properties: {
          access: {
            anyOf: [
              {
                $ref: "#/components/schemas/AccessGrant",
              },
              {
                type: "null",
              },
            ],
          },
          arrival_handle: {
            type: "string",
          },
          guest_credential: {
            type: "string",
          },
          identity: {
            type: "string",
          },
          retry_after: {
            type: "integer",
          },
          space: {
            additionalProperties: false,
            properties: {
              admission_mode: {
                type: "string",
              },
              name: {
                type: "string",
              },
              slug: {
                type: "string",
              },
            },
            required: ["admission_mode", "name", "slug"],
            type: ["object", "null"],
          },
          state: {
            type: "string",
          },
        },
        required: ["state"],
        type: "object",
      },
      PublicSpaceCreated: {
        additionalProperties: false,
        properties: {
          arrival: {
            $ref: "#/components/schemas/PublicSpaceArrival",
          },
          guest_credential: {
            type: "string",
          },
          invite_link: {
            type: "string",
          },
          lifecycle_until: {
            $ref: "#/components/schemas/DateTimeString",
          },
          space: {
            additionalProperties: false,
            properties: {
              admission_mode: {
                type: "string",
              },
              name: {
                type: "string",
              },
              slug: {
                type: "string",
              },
            },
            required: ["admission_mode", "name", "slug"],
            type: "object",
          },
        },
        required: ["arrival", "invite_link", "lifecycle_until", "space"],
        type: "object",
      },
      PublicStatus: {
        additionalProperties: false,
        properties: {
          components: {
            items: {
              additionalProperties: false,
              properties: {
                checked_at: {
                  anyOf: [
                    {
                      $ref: "#/components/schemas/DateTimeString",
                    },
                    {
                      type: "null",
                    },
                  ],
                },
                description: {
                  type: "string",
                },
                id: {
                  $ref: "#/components/schemas/StatusComponentId",
                },
                last_changed_at: {
                  anyOf: [
                    {
                      $ref: "#/components/schemas/DateTimeString",
                    },
                    {
                      type: "null",
                    },
                  ],
                },
                name: {
                  type: "string",
                },
                state: {
                  type: "string",
                },
              },
              required: ["checked_at", "description", "id", "last_changed_at", "name", "state"],
              type: "object",
            },
            type: "array",
          },
          generated_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          overall: {
            type: "string",
          },
          schema_version: {
            type: "integer",
          },
        },
        required: ["components", "generated_at", "overall", "schema_version"],
        type: "object",
      },
      RecentAuth: {
        additionalProperties: false,
        properties: {
          expires_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          proof: {
            type: "string",
          },
        },
        required: ["expires_at", "proof"],
        type: "object",
      },
      RecentAuthGoogleStart: {
        additionalProperties: false,
        properties: {
          authorization_url: {
            $ref: "#/components/schemas/URLString",
          },
          state: {
            type: "string",
          },
        },
        required: ["authorization_url", "state"],
        type: "object",
      },
      RecentAuthRequest: {
        additionalProperties: false,
        properties: {
          action: {
            minLength: 1,
            type: "string",
          },
          password: {
            minLength: 1,
            type: "string",
          },
          provider: {
            minLength: 1,
            type: "string",
          },
          provider_code: {
            minLength: 1,
            type: "string",
          },
          provider_state: {
            minLength: 1,
            type: "string",
          },
          resource_id: {
            anyOf: [
              {
                $ref: "#/components/schemas/UUID",
              },
              {
                type: "null",
              },
            ],
          },
        },
        required: ["action", "password", "provider", "provider_code", "provider_state"],
        type: "object",
      },
      Recording: {
        additionalProperties: false,
        properties: {
          created_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          episode_id: {
            $ref: "#/components/schemas/EpisodeId",
          },
          id: {
            $ref: "#/components/schemas/RecordingId",
          },
          metadata: {
            additionalProperties: true,
            items: {},
            type: ["object", "array", "string", "number", "boolean", "null"],
          },
          space_id: {
            $ref: "#/components/schemas/SpaceId",
          },
          status: {
            enum: ["pending", "processing", "completed", "failed"],
            type: "string",
          },
          storage_key: {
            type: ["string", "null"],
          },
          storage_provider: {
            enum: ["r2"],
            type: "string",
          },
          tenant_id: {
            $ref: "#/components/schemas/TenantId",
          },
          updated_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
        },
        required: ["created_at", "episode_id", "id", "metadata", "space_id", "status", "storage_key", "storage_provider", "tenant_id", "updated_at"],
        type: "object",
      },
      RecordingDownloadURL: {
        additionalProperties: false,
        properties: {
          expires_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          method: {
            type: "string",
          },
          signed_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          signed_headers: {
            additionalProperties: {
              items: {
                type: "string",
              },
              type: "array",
            },
            type: "object",
          },
          url: {
            type: "string",
          },
        },
        required: ["expires_at", "method", "signed_at", "signed_headers", "url"],
        type: "object",
      },
      RecordingId: {
        format: "uuid",
        maxLength: 36,
        minLength: 36,
        type: "string",
        "x-chalk-brand": "RecordingId",
      },
      RecordingList: {
        additionalProperties: false,
        properties: {
          pagination: {
            $ref: "#/components/schemas/Pagination",
          },
          recordings: {
            items: {
              $ref: "#/components/schemas/Recording",
            },
            type: "array",
          },
        },
        required: ["pagination", "recordings"],
        type: "object",
      },
      RecordingPipeline: {
        additionalProperties: false,
        properties: {
          capture_completed_at: {
            anyOf: [
              {
                $ref: "#/components/schemas/DateTimeString",
              },
              {
                type: "null",
              },
            ],
          },
          committed_at: {
            anyOf: [
              {
                $ref: "#/components/schemas/DateTimeString",
              },
              {
                type: "null",
              },
            ],
          },
          created_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          recording_id: {
            $ref: "#/components/schemas/RecordingId",
          },
          reservation_id: {
            $ref: "#/components/schemas/UUID",
          },
          state: {
            type: "string",
          },
          tenant_id: {
            $ref: "#/components/schemas/TenantId",
          },
          updated_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
        },
        required: ["capture_completed_at", "committed_at", "created_at", "recording_id", "reservation_id", "state", "tenant_id", "updated_at"],
        type: "object",
      },
      RecordingReservation: {
        additionalProperties: false,
        properties: {
          created_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          ends_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          episode_id: {
            $ref: "#/components/schemas/EpisodeId",
          },
          id: {
            $ref: "#/components/schemas/UUID",
          },
          input_bitrate_bps: {
            type: "integer",
          },
          max_duration_minutes: {
            type: "integer",
          },
          participant_count: {
            type: "integer",
          },
          recording_id: {
            $ref: "#/components/schemas/RecordingId",
          },
          scheduled_start: {
            type: ["string", "null"],
          },
          space_id: {
            $ref: "#/components/schemas/SpaceId",
          },
          state: {
            type: "string",
          },
          tenant_id: {
            $ref: "#/components/schemas/TenantId",
          },
          updated_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
        },
        required: ["created_at", "ends_at", "episode_id", "id", "input_bitrate_bps", "max_duration_minutes", "participant_count", "recording_id", "scheduled_start", "space_id", "state", "tenant_id", "updated_at"],
        type: "object",
      },
      RefreshSpacePublicInviteAccessRequest: {
        additionalProperties: false,
        properties: {
          media_proof: {
            minLength: 1,
            type: "string",
          },
          replace_media_connection: {
            type: "boolean",
          },
        },
        required: ["media_proof", "replace_media_connection"],
        type: "object",
      },
      Regions: {
        additionalProperties: false,
        properties: {
          regions: {
            items: {
              additionalProperties: false,
              properties: {
                code: {
                  type: "string",
                },
                name: {
                  type: "string",
                },
              },
              required: ["code", "name"],
              type: "object",
            },
            type: "array",
          },
        },
        required: ["regions"],
        type: "object",
      },
      RegisterRequest: {
        additionalProperties: false,
        properties: {
          email: {
            $ref: "#/components/schemas/Email",
          },
          name: {
            minLength: 1,
            type: "string",
          },
          password: {
            minLength: 1,
            type: "string",
          },
        },
        required: ["email", "name", "password"],
        type: "object",
      },
      RemoveEpisodeParticipantRequest: {
        $ref: "#/components/schemas/LeaveDashboardSpaceSelfRequest",
      },
      RequestTranscriptRequest: {
        additionalProperties: false,
        properties: {
          idempotency_key: {
            minLength: 1,
            type: "string",
          },
          language: {
            minLength: 1,
            type: "string",
          },
          languages: {
            items: {
              minLength: 1,
              type: "string",
            },
            minItems: 1,
            type: "array",
          },
        },
        required: ["idempotency_key", "language", "languages"],
        type: "object",
      },
      RotateAPIKeyRequest: {
        additionalProperties: false,
        properties: {
          expires_at: {
            anyOf: [
              {
                $ref: "#/components/schemas/DateTimeString",
              },
              {
                type: "null",
              },
            ],
          },
        },
        type: "object",
      },
      RotateWebhookSecretRequest: {
        additionalProperties: false,
        properties: {
          revoke_previous_immediately: {
            type: "boolean",
          },
        },
        required: ["revoke_previous_immediately"],
        type: "object",
      },
      RotateWebhookSecretResponse: {
        additionalProperties: false,
        properties: {
          endpoint_id: {
            $ref: "#/components/schemas/UUID",
          },
          previous_secret_expires_at: {
            anyOf: [
              {
                $ref: "#/components/schemas/DateTimeString",
              },
              {
                type: "null",
              },
            ],
          },
          revision: {
            type: "integer",
          },
          secret: {
            type: "string",
          },
        },
        required: ["endpoint_id", "previous_secret_expires_at", "revision", "secret"],
        type: "object",
      },
      SetEpisodeDeadlineRequest: {
        additionalProperties: false,
        properties: {
          deadline_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
        },
        required: ["deadline_at"],
        type: "object",
      },
      Space: {
        additionalProperties: false,
        properties: {
          admission_policy: {
            additionalProperties: true,
            items: {},
            type: ["object", "array", "string", "number", "boolean", "null"],
          },
          archived: {
            type: "boolean",
          },
          archived_at: {
            anyOf: [
              {
                $ref: "#/components/schemas/DateTimeString",
              },
              {
                type: "null",
              },
            ],
          },
          created_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          created_by_user_id: {
            anyOf: [
              {
                $ref: "#/components/schemas/UserId",
              },
              {
                type: "null",
              },
            ],
          },
          default_episode_duration_seconds: {
            type: "integer",
          },
          id: {
            $ref: "#/components/schemas/SpaceId",
          },
          linger_window_seconds: {
            type: "integer",
          },
          maximum_episode_duration_seconds: {
            type: "integer",
          },
          media_plane: {
            type: "string",
          },
          metadata: {
            additionalProperties: true,
            items: {},
            type: ["object", "array", "string", "number", "boolean", "null"],
          },
          name: {
            type: "string",
          },
          recurring_policy: {
            additionalProperties: true,
            items: {},
            type: ["object", "array", "string", "number", "boolean", "null"],
          },
          roles: {
            items: {
              additionalProperties: false,
              properties: {
                capabilities: {
                  items: {
                    type: "string",
                  },
                  type: "array",
                },
                id: {
                  $ref: "#/components/schemas/SpaceId",
                },
                name: {
                  type: "string",
                },
              },
              required: ["capabilities", "id", "name"],
              type: "object",
            },
            type: "array",
          },
          slug: {
            type: "string",
          },
          tenant_id: {
            $ref: "#/components/schemas/TenantId",
          },
          updated_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
        },
        required: ["admission_policy", "archived", "created_at", "created_by_user_id", "default_episode_duration_seconds", "id", "linger_window_seconds", "maximum_episode_duration_seconds", "media_plane", "metadata", "name", "recurring_policy", "roles", "slug", "tenant_id", "updated_at"],
        type: "object",
      },
      SpaceId: {
        format: "uuid",
        maxLength: 36,
        minLength: 36,
        type: "string",
        "x-chalk-brand": "SpaceId",
      },
      SpaceList: {
        additionalProperties: false,
        properties: {
          pagination: {
            $ref: "#/components/schemas/Pagination",
          },
          spaces: {
            items: {
              $ref: "#/components/schemas/Space",
            },
            type: "array",
          },
        },
        required: ["pagination", "spaces"],
        type: "object",
      },
      SpacePublicInvite: {
        additionalProperties: false,
        properties: {
          admission_mode: {
            type: "string",
          },
          canonical_url: {
            $ref: "#/components/schemas/URLString",
          },
          created_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          disabled_at: {
            anyOf: [
              {
                $ref: "#/components/schemas/DateTimeString",
              },
              {
                type: "null",
              },
            ],
          },
          enabled: {
            type: "boolean",
          },
          generation: {
            minimum: 0,
            type: "integer",
          },
          public_role: {
            type: "string",
          },
          rotated_at: {
            anyOf: [
              {
                $ref: "#/components/schemas/DateTimeString",
              },
              {
                type: "null",
              },
            ],
          },
          schema_version: {
            type: "string",
          },
          space_id: {
            $ref: "#/components/schemas/SpaceId",
          },
          tenant_id: {
            $ref: "#/components/schemas/TenantId",
          },
          updated_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
        },
        required: ["admission_mode", "canonical_url", "created_at", "enabled", "generation", "public_role", "schema_version", "space_id", "tenant_id", "updated_at"],
        type: "object",
      },
      SpacePublicInviteArrivalRequest: {
        additionalProperties: false,
        properties: {
          display_name: {
            minLength: 1,
            type: "string",
          },
          space_invite_token: {
            minLength: 1,
            type: "string",
          },
        },
        required: ["display_name", "space_invite_token"],
        type: "object",
      },
      StartIntegrationConnectionRequest: {
        additionalProperties: false,
        properties: {
          account_alias: {
            minLength: 1,
            type: ["string", "null"],
          },
          callback_url: {
            anyOf: [
              {
                $ref: "#/components/schemas/URLString",
              },
              {
                type: "null",
              },
            ],
          },
          provider: {
            minLength: 1,
            type: "string",
          },
          service: {
            minLength: 1,
            type: "string",
          },
        },
        required: ["provider", "service"],
        type: "object",
      },
      Status: {
        additionalProperties: false,
        properties: {
          status: {
            type: "string",
          },
        },
        required: ["status"],
        type: "object",
      },
      StatusComponentId: {
        minLength: 1,
        type: "string",
        "x-chalk-brand": "StatusComponentId",
      },
      StatusMonitorIdentifier: {
        minLength: 1,
        type: "string",
        "x-chalk-brand": "StatusMonitorIdentifier",
      },
      StatusMonitorResult: {
        additionalProperties: false,
        properties: {
          checked_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          details: {
            additionalProperties: {
              additionalProperties: true,
              items: {},
              type: ["object", "array", "string", "number", "boolean", "null"],
            },
            type: "object",
          },
          error_code: {
            minLength: 1,
            type: "string",
          },
          error_message: {
            minLength: 1,
            type: "string",
          },
          event_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          http_status: {
            type: ["integer", "null"],
          },
          latency_ms: {
            type: "integer",
          },
          metadata: {
            additionalProperties: {
              additionalProperties: true,
              items: {},
              type: ["object", "array", "string", "number", "boolean", "null"],
            },
            type: "object",
          },
          monitor_key: {
            minLength: 1,
            type: "string",
          },
          reported_emitter_id: {
            $ref: "#/components/schemas/StatusMonitorIdentifier",
          },
          reported_source: {
            minLength: 1,
            type: "string",
          },
          response_excerpt: {
            minLength: 1,
            type: "string",
          },
          result_key: {
            minLength: 1,
            type: "string",
          },
          run_id: {
            $ref: "#/components/schemas/StatusMonitorIdentifier",
          },
          status: {
            minLength: 1,
            type: "string",
          },
        },
        required: ["checked_at", "event_at", "latency_ms", "monitor_key", "reported_emitter_id", "reported_source", "result_key", "run_id", "status"],
        type: "object",
      },
      StatusMonitorResultAccepted: {
        additionalProperties: false,
        properties: {
          accepted: {
            type: "boolean",
          },
          duplicate: {
            type: "boolean",
          },
        },
        required: ["accepted", "duplicate"],
        type: "object",
      },
      StorageProviderConfig: {
        additionalProperties: true,
        properties: {
          access_key_id: {
            minLength: 1,
            type: "string",
          },
          bucket: {
            minLength: 1,
            type: "string",
          },
          enabled: {
            type: "boolean",
          },
          mode: {
            enum: ["chalk_managed", "tenant_managed"],
            type: "string",
          },
          prefix: {
            minLength: 1,
            type: "string",
          },
          provider: {
            enum: ["cloudflare_r2", "aws_s3"],
            type: "string",
          },
          secret_access_key: {
            minLength: 1,
            type: "string",
          },
        },
        type: "object",
      },
      SyncToken: {
        additionalProperties: false,
        properties: {
          expires_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          sync_token: {
            type: "string",
          },
        },
        required: ["expires_at", "sync_token"],
        type: "object",
      },
      Tenant: {
        additionalProperties: false,
        properties: {
          ai_provider_config: {
            anyOf: [
              {
                $ref: "#/components/schemas/AIProviderConfig",
              },
              {
                type: "null",
              },
            ],
          },
          created_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          default_media_plane: {
            type: ["string", "null"],
          },
          default_region: {
            type: ["string", "null"],
          },
          id: {
            $ref: "#/components/schemas/TenantId",
          },
          logo_key: {
            type: ["string", "null"],
          },
          media_plane_provider_config: {
            anyOf: [
              {
                $ref: "#/components/schemas/MediaPlaneProviderConfig",
              },
              {
                type: "null",
              },
            ],
          },
          name: {
            type: "string",
          },
          storage_provider_config: {
            anyOf: [
              {
                $ref: "#/components/schemas/StorageProviderConfig",
              },
              {
                type: "null",
              },
            ],
          },
          updated_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          website: {
            anyOf: [
              {
                $ref: "#/components/schemas/URLString",
              },
              {
                type: "null",
              },
            ],
          },
        },
        required: ["ai_provider_config", "created_at", "default_media_plane", "default_region", "id", "logo_key", "media_plane_provider_config", "name", "storage_provider_config", "updated_at", "website"],
        type: "object",
      },
      TenantId: {
        format: "uuid",
        maxLength: 36,
        minLength: 36,
        type: "string",
        "x-chalk-brand": "TenantId",
      },
      TenantList: {
        additionalProperties: false,
        properties: {
          pagination: {
            $ref: "#/components/schemas/Pagination",
          },
          tenants: {
            items: {
              $ref: "#/components/schemas/Tenant",
            },
            type: "array",
          },
        },
        required: ["pagination", "tenants"],
        type: "object",
      },
      Transcript: {
        additionalProperties: false,
        properties: {
          artifact_content_type: {
            type: ["string", "null"],
          },
          artifact_size: {
            type: ["integer", "null"],
          },
          completed_at: {
            anyOf: [
              {
                $ref: "#/components/schemas/DateTimeString",
              },
              {
                type: "null",
              },
            ],
          },
          created_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          deleted_at: {
            anyOf: [
              {
                $ref: "#/components/schemas/DateTimeString",
              },
              {
                type: "null",
              },
            ],
          },
          episode_id: {
            $ref: "#/components/schemas/EpisodeId",
          },
          generation: {
            type: "integer",
          },
          id: {
            $ref: "#/components/schemas/TranscriptId",
          },
          languages: {
            items: {
              minLength: 1,
              type: "string",
            },
            minItems: 1,
            type: "array",
          },
          model: {
            type: "string",
          },
          provider: {
            type: "string",
          },
          recording_id: {
            $ref: "#/components/schemas/RecordingId",
          },
          space_id: {
            $ref: "#/components/schemas/SpaceId",
          },
          status: {
            enum: ["pending", "processing", "completed", "failed"],
            type: "string",
          },
          tenant_id: {
            $ref: "#/components/schemas/TenantId",
          },
          updated_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
        },
        required: ["created_at", "episode_id", "generation", "id", "languages", "recording_id", "space_id", "status", "tenant_id", "updated_at"],
        type: "object",
      },
      TranscriptDownloadURL: {
        additionalProperties: false,
        properties: {
          expires_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          method: {
            type: "string",
          },
          signed_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          signed_headers: {
            additionalProperties: {
              items: {
                type: "string",
              },
              type: "array",
            },
            type: "object",
          },
          url: {
            type: "string",
          },
        },
        required: ["expires_at", "method", "signed_at", "signed_headers", "url"],
        type: "object",
      },
      TranscriptId: {
        format: "uuid",
        maxLength: 36,
        minLength: 36,
        type: "string",
        "x-chalk-brand": "TranscriptId",
      },
      TranscriptList: {
        additionalProperties: false,
        properties: {
          pagination: {
            $ref: "#/components/schemas/Pagination",
          },
          transcripts: {
            items: {
              $ref: "#/components/schemas/Transcript",
            },
            type: "array",
          },
        },
        required: ["pagination", "transcripts"],
        type: "object",
      },
      TranscriptRequestAcceptedResponse: {
        additionalProperties: false,
        properties: {
          job_id: {
            $ref: "#/components/schemas/UUID",
          },
          status: {
            type: "string",
          },
          transcript: {
            $ref: "#/components/schemas/Transcript",
          },
        },
        required: ["job_id", "status", "transcript"],
        type: "object",
      },
      URLString: {
        format: "uri",
        type: "string",
        "x-chalk-brand": "URLString",
      },
      UUID: {
        format: "uuid",
        maxLength: 36,
        minLength: 36,
        type: "string",
        "x-chalk-brand": "UUID",
      },
      UpdateMembershipRequest: {
        additionalProperties: false,
        properties: {
          role: {
            enum: ["owner", "collaborator", "observer"],
            type: "string",
          },
        },
        required: ["role"],
        type: "object",
      },
      UpdateRecordingRequest: {
        additionalProperties: false,
        properties: {
          metadata: {
            additionalProperties: true,
            items: {},
            type: ["object", "array", "string", "number", "boolean", "null"],
          },
          status: {
            enum: ["pending", "processing", "completed", "failed"],
            type: "string",
          },
          storage_key: {
            minLength: 1,
            type: ["string", "null"],
          },
          storage_provider: {
            enum: ["r2"],
            type: "string",
          },
        },
        type: "object",
      },
      UpdateSpacePublicInviteRequest: {
        additionalProperties: false,
        properties: {
          enabled: {
            type: "boolean",
          },
        },
        required: ["enabled"],
        type: "object",
      },
      UpdateSpaceRequest: {
        additionalProperties: false,
        properties: {
          admission_policy: {
            additionalProperties: true,
            items: {},
            type: ["object", "array", "string", "number", "boolean", "null"],
          },
          default_episode_duration_seconds: {
            additionalProperties: false,
            properties: {
              Set: {
                type: "boolean",
              },
              Value: {
                type: ["integer", "null"],
              },
            },
            required: ["Set"],
            type: "object",
          },
          linger_window_seconds: {
            additionalProperties: false,
            properties: {
              Set: {
                type: "boolean",
              },
              Value: {
                type: ["integer", "null"],
              },
            },
            required: ["Set"],
            type: "object",
          },
          maximum_episode_duration_seconds: {
            additionalProperties: false,
            properties: {
              Set: {
                type: "boolean",
              },
              Value: {
                type: ["integer", "null"],
              },
            },
            required: ["Set"],
            type: "object",
          },
          media_plane: {
            minLength: 1,
            type: "string",
          },
          metadata: {
            additionalProperties: true,
            items: {},
            type: ["object", "array", "string", "number", "boolean", "null"],
          },
          name: {
            minLength: 1,
            type: "string",
          },
          recurring_policy: {
            additionalProperties: true,
            items: {},
            type: ["object", "array", "string", "number", "boolean", "null"],
          },
          slug: {
            minLength: 1,
            type: "string",
          },
        },
        required: ["default_episode_duration_seconds", "linger_window_seconds", "maximum_episode_duration_seconds"],
        type: "object",
      },
      UpdateTenantRequest: {
        additionalProperties: false,
        properties: {
          ai_provider_config: {
            anyOf: [
              {
                $ref: "#/components/schemas/AIProviderConfig",
              },
              {
                type: "null",
              },
            ],
          },
          default_media_plane: {
            minLength: 1,
            type: ["string", "null"],
          },
          default_region: {
            minLength: 1,
            type: ["string", "null"],
          },
          logo_key: {
            minLength: 1,
            type: ["string", "null"],
          },
          media_plane_provider_config: {
            anyOf: [
              {
                $ref: "#/components/schemas/MediaPlaneProviderConfig",
              },
              {
                type: "null",
              },
            ],
          },
          name: {
            minLength: 1,
            type: "string",
          },
          storage_provider_config: {
            anyOf: [
              {
                $ref: "#/components/schemas/StorageProviderConfig",
              },
              {
                type: "null",
              },
            ],
          },
          website: {
            anyOf: [
              {
                $ref: "#/components/schemas/URLString",
              },
              {
                type: "null",
              },
            ],
          },
        },
        type: "object",
      },
      UpdateWebhookEndpointRequest: {
        additionalProperties: false,
        properties: {
          api_version: {
            type: "integer",
          },
          enabled: {
            type: "boolean",
          },
          event_types: {
            items: {
              type: "string",
            },
            type: "array",
          },
          name: {
            minLength: 1,
            type: "string",
          },
          url: {
            minLength: 1,
            type: "string",
          },
        },
        type: "object",
      },
      User: {
        additionalProperties: false,
        properties: {
          created_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          email: {
            $ref: "#/components/schemas/Email",
          },
          id: {
            $ref: "#/components/schemas/UserId",
          },
          name: {
            type: "string",
          },
          updated_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
        },
        required: ["created_at", "email", "id", "name", "updated_at"],
        type: "object",
      },
      UserId: {
        format: "uuid",
        maxLength: 36,
        minLength: 36,
        type: "string",
        "x-chalk-brand": "UserId",
      },
      UserList: {
        additionalProperties: false,
        properties: {
          pagination: {
            $ref: "#/components/schemas/Pagination",
          },
          users: {
            items: {
              $ref: "#/components/schemas/User",
            },
            type: "array",
          },
        },
        required: ["pagination", "users"],
        type: "object",
      },
      WebhookDeliveryCreated: {
        additionalProperties: false,
        properties: {
          delivery_id: {
            $ref: "#/components/schemas/UUID",
          },
          endpoint_id: {
            $ref: "#/components/schemas/UUID",
          },
          endpoint_revision: {
            type: "integer",
          },
          event_id: {
            $ref: "#/components/schemas/UUID",
          },
          state: {
            type: "string",
          },
        },
        required: ["delivery_id", "endpoint_id", "endpoint_revision", "event_id", "state"],
        type: "object",
      },
      WebhookDeliveryDetail: {
        additionalProperties: false,
        properties: {
          attempt_count: {
            type: "integer",
          },
          attempts: {
            items: {
              additionalProperties: false,
              properties: {
                error_code: {
                  type: ["string", "null"],
                },
                finished_at: {
                  anyOf: [
                    {
                      $ref: "#/components/schemas/DateTimeString",
                    },
                    {
                      type: "null",
                    },
                  ],
                },
                http_status: {
                  type: ["integer", "null"],
                },
                id: {
                  $ref: "#/components/schemas/UUID",
                },
                latency_milliseconds: {
                  type: ["integer", "null"],
                },
                number: {
                  type: "integer",
                },
                outcome: {
                  type: "string",
                },
                started_at: {
                  $ref: "#/components/schemas/DateTimeString",
                },
              },
              required: ["error_code", "finished_at", "http_status", "id", "latency_milliseconds", "number", "outcome", "started_at"],
              type: "object",
            },
            type: "array",
          },
          created_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          endpoint_id: {
            $ref: "#/components/schemas/UUID",
          },
          endpoint_revision: {
            type: "integer",
          },
          event: {
            additionalProperties: true,
            items: {},
            type: ["object", "array", "string", "number", "boolean", "null"],
          },
          event_id: {
            $ref: "#/components/schemas/UUID",
          },
          event_type: {
            type: "string",
          },
          id: {
            $ref: "#/components/schemas/UUID",
          },
          next_attempt_at: {
            anyOf: [
              {
                $ref: "#/components/schemas/DateTimeString",
              },
              {
                type: "null",
              },
            ],
          },
          state: {
            type: "string",
          },
          terminal_at: {
            anyOf: [
              {
                $ref: "#/components/schemas/DateTimeString",
              },
              {
                type: "null",
              },
            ],
          },
          updated_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
        },
        required: ["attempt_count", "attempts", "created_at", "endpoint_id", "endpoint_revision", "event", "event_id", "event_type", "id", "next_attempt_at", "state", "terminal_at", "updated_at"],
        type: "object",
      },
      WebhookDeliveryList: {
        additionalProperties: false,
        properties: {
          deliveries: {
            items: {
              additionalProperties: false,
              properties: {
                attempt_count: {
                  type: "integer",
                },
                created_at: {
                  $ref: "#/components/schemas/DateTimeString",
                },
                endpoint_id: {
                  $ref: "#/components/schemas/UUID",
                },
                endpoint_revision: {
                  type: "integer",
                },
                event_id: {
                  $ref: "#/components/schemas/UUID",
                },
                event_type: {
                  type: "string",
                },
                id: {
                  $ref: "#/components/schemas/UUID",
                },
                next_attempt_at: {
                  anyOf: [
                    {
                      $ref: "#/components/schemas/DateTimeString",
                    },
                    {
                      type: "null",
                    },
                  ],
                },
                state: {
                  type: "string",
                },
                terminal_at: {
                  anyOf: [
                    {
                      $ref: "#/components/schemas/DateTimeString",
                    },
                    {
                      type: "null",
                    },
                  ],
                },
                updated_at: {
                  $ref: "#/components/schemas/DateTimeString",
                },
              },
              required: ["attempt_count", "created_at", "endpoint_id", "endpoint_revision", "event_id", "event_type", "id", "next_attempt_at", "state", "terminal_at", "updated_at"],
              type: "object",
            },
            type: "array",
          },
          page: {
            additionalProperties: false,
            properties: {
              next_cursor: {
                type: ["string", "null"],
              },
            },
            required: ["next_cursor"],
            type: "object",
          },
        },
        required: ["deliveries", "page"],
        type: "object",
      },
      WebhookEndpoint: {
        additionalProperties: false,
        properties: {
          api_version: {
            type: "integer",
          },
          created_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          enabled: {
            type: "boolean",
          },
          event_types: {
            items: {
              type: "string",
            },
            type: "array",
          },
          id: {
            $ref: "#/components/schemas/UUID",
          },
          name: {
            type: "string",
          },
          revision: {
            type: "integer",
          },
          tenant_id: {
            $ref: "#/components/schemas/TenantId",
          },
          updated_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          url_redacted: {
            type: "string",
          },
        },
        required: ["api_version", "created_at", "enabled", "event_types", "id", "name", "revision", "tenant_id", "updated_at", "url_redacted"],
        type: "object",
      },
      WebhookEndpointList: {
        additionalProperties: false,
        properties: {
          page: {
            additionalProperties: false,
            properties: {
              next_cursor: {
                type: ["string", "null"],
              },
            },
            required: ["next_cursor"],
            type: "object",
          },
          webhook_endpoints: {
            items: {
              $ref: "#/components/schemas/WebhookEndpoint",
            },
            type: "array",
          },
        },
        required: ["page", "webhook_endpoints"],
        type: "object",
      },
      WebhookEndpointWithSecret: {
        additionalProperties: false,
        properties: {
          api_version: {
            type: "integer",
          },
          created_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          enabled: {
            type: "boolean",
          },
          event_types: {
            items: {
              type: "string",
            },
            type: "array",
          },
          id: {
            $ref: "#/components/schemas/UUID",
          },
          name: {
            type: "string",
          },
          revision: {
            type: "integer",
          },
          secret: {
            type: "string",
          },
          tenant_id: {
            $ref: "#/components/schemas/TenantId",
          },
          updated_at: {
            $ref: "#/components/schemas/DateTimeString",
          },
          url_redacted: {
            type: "string",
          },
        },
        required: ["api_version", "created_at", "enabled", "event_types", "id", "name", "revision", "secret", "tenant_id", "updated_at", "url_redacted"],
        type: "object",
      },
      WhiteboardFileDownload: {
        additionalProperties: false,
        properties: {
          downloadUrl: {
            type: "string",
          },
          expiresAt: {
            type: "string",
          },
        },
        required: ["downloadUrl", "expiresAt"],
        type: "object",
      },
      WhiteboardFileUpload: {
        additionalProperties: false,
        properties: {
          expiresAt: {
            type: "string",
          },
          headers: {
            additionalProperties: {
              type: "string",
            },
            type: "object",
          },
          method: {
            type: "string",
          },
          uploadId: {
            type: "string",
          },
          uploadUrl: {
            type: "string",
          },
        },
        required: ["expiresAt", "headers", "method", "uploadId", "uploadUrl"],
        type: "object",
      },
    },
  },
};
