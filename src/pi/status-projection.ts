import type { BridgeStatusResponse } from "../protocol/schema.js";
import type { SessionAuthorizationSnapshot } from "./session-runtime-owner.js";

export type ChromeStatusProjection = Readonly<{
  kind: "pi-chrome/status";
  version: 1;
  readiness: "ready" | "offline" | "locked" | "error";
  authorization: "indefinite" | "locked" | Readonly<{ expiresAt: number }>;
  connection: "connected" | "offline" | "unavailable" | "unpaired" | "unknown";
  bridge: "running" | "stopped" | "error";
  connectorId?: string;
  connectorLabel?: string;
  connectorExpiresAt?: number;
  errorMessage?: string;
}>;

export type BridgeStatusSnapshot =
  | Readonly<{ _tag: "Available"; status: BridgeStatusResponse }>
  | Readonly<{ _tag: "Error"; message: string }>;

const authorizationProjection = (
  session: SessionAuthorizationSnapshot,
  now: number,
): ChromeStatusProjection["authorization"] => {
  if (session._tag !== "Active") return "locked";
  if (session.authorization.state === "indefinite") return "indefinite";
  return session.authorization.state === "timed" && session.authorization.deadline > now
    ? { expiresAt: session.authorization.deadline }
    : "locked";
};

export const projectChromeStatus = (
  session: SessionAuthorizationSnapshot,
  bridgeSnapshot: BridgeStatusSnapshot,
  now: number,
  sessionKey?: string,
): ChromeStatusProjection => {
  const authorization = authorizationProjection(session, now);
  if (bridgeSnapshot._tag === "Error") {
    const readiness =
      session._tag === "Poisoned" ? "error" : authorization === "locked" ? "locked" : "error";
    return {
      kind: "pi-chrome/status",
      version: 1,
      readiness,
      authorization,
      connection: "unknown",
      bridge: "error",
      errorMessage:
        session._tag === "Poisoned"
          ? "Chrome authorization ledger is fail-closed"
          : bridgeSnapshot.message,
    };
  }

  const { status } = bridgeSnapshot;
  const sessionRoute = sessionKey
    ? status.sessionRoutes.find((route) => route.sessionKey === sessionKey)
    : undefined;
  const connection: ChromeStatusProjection["connection"] = sessionRoute
    ? sessionRoute.availability === "expired"
      ? "unavailable"
      : sessionRoute.connected
        ? "connected"
        : "offline"
    : !status.binding
      ? "unpaired"
      : status.connector.connected
        ? "connected"
        : "offline";
  const shared: Omit<ChromeStatusProjection, "readiness" | "errorMessage"> = {
    kind: "pi-chrome/status" as const,
    version: 1 as const,
    authorization,
    connection,
    bridge: status.mode === "server" || status.mode === "client" ? "running" : "stopped",
    ...(sessionRoute
      ? {
          connectorId: sessionRoute.connector.connectorId,
          connectorLabel: sessionRoute.connector.label,
          ...(sessionRoute.availability === "live"
            ? { connectorExpiresAt: sessionRoute.expiresAt }
            : {}),
        }
      : status.binding
        ? {
            connectorId: status.binding.connectorId,
            connectorLabel: status.binding.label,
          }
        : {}),
  };

  if (session._tag === "Poisoned") {
    return {
      ...shared,
      readiness: "error",
      errorMessage: "Chrome authorization ledger is fail-closed",
    };
  }
  if (authorization === "locked") return { ...shared, readiness: "locked" };
  if (shared.bridge === "stopped") {
    return {
      ...shared,
      readiness: "error",
      errorMessage: "Chrome bridge is stopped",
    };
  }
  return { ...shared, readiness: connection === "connected" ? "ready" : "offline" };
};
