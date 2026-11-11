/**
 * lib/env.ts — environment loading for local development (side-effect module).
 *
 * Carbon Pass 2, Finding 1: in Node ESM, static imports are evaluated
 * BEFORE any top-level code in the importing file runs. server.ts used to
 * call dotenv.config() on a later line, but by then its statically
 * imported api/*.ts -> lib/constants.js chain had already evaluated
 * (reading env vars while process.env was still unpopulated).
 *
 * This module exists for one reason: it must be the FIRST import in
 * server.ts so dotenv runs before any other module in the graph is
 * evaluated. `.env.local` is listed first so it wins over `.env`
 * (dotenv never overwrites an already-set variable).
 *
 * Vercel deployments do not use this file — Vercel injects env vars
 * directly. It is only imported by server.ts (local dev).
 */
import dotenv from "dotenv";

dotenv.config({ path: [".env.local", ".env"] });
