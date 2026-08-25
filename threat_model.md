# Threat Model

## Project Overview

NoBull OS is a public-facing React + Express + TypeScript application for internal legal-marketing operations, reporting, communications, and client review workflows. It runs on Replit autoscale, uses Replit Auth (OIDC) for user login, stores business data in PostgreSQL, and connects to high-value third-party services including Twilio, Front, Google, Zoom, SEMrush, and OpenAI.

This threat model is production-scoped. Dev-only tests, scripts, and sandbox-only mockup paths are out of scope unless they are shown to be reachable from the deployed app. TLS is handled by the platform.

## Assets

- **User accounts and sessions** — authenticated sessions are the front door to the internal app. If outsiders can create or keep sessions they should not have, they can reach internal APIs and admin-adjacent workflows.
- **Client business data** — RIS, live-data snapshots, reporting inputs, communications metadata, and client configuration are sensitive commercial data. Exposure or tampering can harm customers and business operations.
- **Internal staff directory and operational settings** — employee names, emails, roles, routing preferences, telephony configuration, and workflow metadata can be used for phishing, impersonation, or operational abuse.
- **Third-party integration secrets and control surfaces** — Twilio, Google, Front, Zoom, OpenAI, and similar integrations expand impact if their configuration or management surfaces are exposed.
- **Audit and workflow integrity** — queues, reporting ledgers, and admin-triggered refresh paths must not be writable by ordinary users or outsiders.

## Trust Boundaries

- **Public browser to backend API** — all client traffic is untrusted. Public routes must not grant internal access without an explicit enrollment decision.
- **Authenticated user to privileged internal user** — login alone is not enough. The app needs a hard server-side boundary between ordinary authenticated users and internal roles such as reporting experts, team leads, and CEOs.
- **Backend to PostgreSQL** — route handlers and permission helpers decide what business records are returned or changed. A bad default here becomes organization-wide exposure.
- **Backend to external providers** — the server holds powerful credentials for Twilio, Google, Front, Zoom, and others. Internal configuration and control surfaces around those integrations are sensitive even when raw secrets are masked.
- **Production vs dev-only code** — tests, scripts, and local-only tooling should usually be ignored for production findings unless production reachability is demonstrated.

## Scan Anchors

- **Production entry points:** `server/routes/*.ts`, `server/replit_integrations/auth/replitAuth.ts`, and route registration in the Express app.
- **Highest-risk auth areas:** `server/replit_integrations/auth/`, `server/auth/permissions.ts`, and routes using helper gates such as `canAccessRIS` / `canManageRIS`.
- **Public vs authenticated vs admin surfaces:** public login starts at `/api/login`; many internal APIs only check `isAuthenticated`; some legacy admin routes still use hard guards like `requireCeo` / `requireTeamLead`.
- **Usually ignore unless proven reachable:** `tests/`, one-off `scripts/`, and mockup/dev-only artifacts.

## Threat Categories

### Spoofing

This app trusts Replit Auth to establish identity, but the app itself still decides who is allowed to become a local user. The production system must only create or admit local accounts for explicitly approved people. Public login endpoints must not double as open self-registration unless that is an intentional product requirement.

### Tampering

Authenticated users can trigger writes that affect reporting, client health ledgers, mappings, and refresh workflows. Server-side authorization must be deny-by-default for sensitive write paths, and permission helpers must fail closed if their backing setting is missing or unreadable.

### Information Disclosure

The app stores internal staff details, client performance data, communications context, and integration configuration. Authenticated APIs must return the minimum data needed for the caller’s role, and routes that expose internal rosters or integration state must not be reachable by any logged-in account.

### Denial of Service

Public auth endpoints and expensive refresh/reporting actions can be abused to consume worker, database, or provider capacity. Rate limits and privilege checks matter most on login flows and on-demand refresh endpoints that fan out to external systems.

### Elevation of Privilege

The biggest project-specific risk is broken server-side authorization: a user who is merely authenticated must not automatically inherit reporting, manager, or admin-like powers. Central permission helpers are a critical control point and must not default open in production.