import { db } from "../db";
import { users, twilioCalls, twilioMessages, clients } from "@shared/schema";
import { eq, desc, and, or, sql } from "drizzle-orm";
import * as twilioStorage from "../storage/twilioStorage";
// Task #855: shared phone normalization — no per-file inline copies.
import { normalizeToE164 } from "./phoneNormalization";

export interface RoutingTarget {
  userId: string;
  phone: string;
  tier: number;
  userName?: string;
  // Task #877: per-user calling preference. When 'browser', the inbound
  // voice webhook will dial <Client>${userId}</Client> if the user's
  // device is currently registered (see services/browserPresence.ts);
  // otherwise it falls back to <Number>${phone}</Number> just like before.
  callMode?: "browser" | "forward";
}

export interface RoutingChain {
  targets: RoutingTarget[];
  clientId?: string;
  clientName?: string;
  accountManagerUserId?: string;
}

const normalizePhone = normalizeToE164;

export async function resolveRoutingChain(callerPhone: string): Promise<RoutingChain> {
  const chain: RoutingChain = { targets: [] };
  const normalizedCaller = normalizePhone(callerPhone);
  const callerDigits = normalizedCaller.replace(/\D/g, "").slice(-10);

  const match = await twilioStorage.findClientByPhone(callerPhone);
  if (match) {
    chain.clientId = match.clientId;
  }

  let tier1UserId: string | null = null;

  const recentCalls = await db.select({
    userId: twilioCalls.initiatedByUserId,
    createdAt: twilioCalls.createdAt,
  })
    .from(twilioCalls)
    .where(
      and(
        eq(twilioCalls.direction, "outbound"),
        or(
          sql`replace(replace(${twilioCalls.toNumber}, '+1', ''), '+', '') LIKE '%' || ${callerDigits}`,
          sql`${twilioCalls.toNumber} = ${normalizedCaller}`
        )
      )
    )
    .orderBy(desc(twilioCalls.createdAt))
    .limit(1);

  const recentMessages = await db.select({
    userId: twilioMessages.sentByUserId,
    createdAt: twilioMessages.createdAt,
  })
    .from(twilioMessages)
    .where(
      and(
        eq(twilioMessages.direction, "outbound"),
        or(
          sql`replace(replace(${twilioMessages.toNumber}, '+1', ''), '+', '') LIKE '%' || ${callerDigits}`,
          sql`${twilioMessages.toNumber} = ${normalizedCaller}`
        )
      )
    )
    .orderBy(desc(twilioMessages.createdAt))
    .limit(1);

  const callCandidate = recentCalls.length > 0 && recentCalls[0].userId && recentCalls[0].createdAt
    ? { userId: recentCalls[0].userId, at: recentCalls[0].createdAt }
    : null;
  const smsCandidate = recentMessages.length > 0 && recentMessages[0].userId && recentMessages[0].createdAt
    ? { userId: recentMessages[0].userId, at: recentMessages[0].createdAt }
    : null;

  if (callCandidate && smsCandidate) {
    tier1UserId = callCandidate.at >= smsCandidate.at ? callCandidate.userId : smsCandidate.userId;
  } else if (callCandidate) {
    tier1UserId = callCandidate.userId;
  } else if (smsCandidate) {
    tier1UserId = smsCandidate.userId;
  }

  if (tier1UserId) {
    const [tier1User] = await db.select().from(users).where(eq(users.id, tier1UserId));
    const tier1Mode = (tier1User?.callMode === "forward" ? "forward" : "browser") as "browser" | "forward";
    // Browser-mode users can be routed via <Client> even without a
    // callRoutingPhone, since the inbound webhook dials the SDK identity.
    // Forward-mode users still require a callRoutingPhone to be reachable.
    if (tier1User && (tier1Mode === "browser" || tier1User.callRoutingPhone)) {
      chain.targets.push({
        userId: tier1User.id,
        phone: tier1User.callRoutingPhone || "",
        tier: 1,
        userName: [tier1User.firstName, tier1User.lastName].filter(Boolean).join(" ") || undefined,
        callMode: tier1Mode,
      });
    }
  }

  let tier2UserId: string | null = null;
  if (match?.clientId) {
    const [client] = await db.select().from(clients).where(eq(clients.id, match.clientId));
    if (client) {
      chain.clientName = client.firmName;
      if (client.ownerId) {
        chain.accountManagerUserId = client.ownerId;
        tier2UserId = client.ownerId;

        if (tier2UserId !== tier1UserId) {
          const [tier2User] = await db.select().from(users).where(eq(users.id, tier2UserId));
          const tier2Mode = (tier2User?.callMode === "forward" ? "forward" : "browser") as "browser" | "forward";
          if (tier2User && (tier2Mode === "browser" || tier2User.callRoutingPhone)) {
            chain.targets.push({
              userId: tier2User.id,
              phone: tier2User.callRoutingPhone || "",
              tier: 2,
              userName: [tier2User.firstName, tier2User.lastName].filter(Boolean).join(" ") || undefined,
              callMode: tier2Mode,
            });
          }
        }
      }
    }
  }

  return chain;
}
