"use client";

// IoT fleet API module. Wraps the shared axios instance (baseURL "/api/v1")
// and unwraps `.data`, the same convention as features/vms/api.ts. The gateway
// routes "/api/v1/iot/*" → the reading-writer.
//
// READ ONLY, and that is the design rather than a phase. Conflux owns the
// fleet: it mints enrolment tokens, decides pending vs approved, and gateways
// phone home to IT. Nothing is onboarded, renamed or revoked from here — the
// same single-ownership rule the Cameras tab follows for recorder-owned
// cameras.
//
// Backend: backend/reading-writer/app/api/iot.py
//   GET /iot/gateways                  every gateway + its connections
//   GET /iot/gateways/{id}             one gateway
//   GET /iot/gateways/{id}/points      the points we hold for it
//   GET /iot/gateways/{id}/alerts      the faults it delivered
//   POST /iot/gateways/{id}/approve|revoke   trust / stop trusting one
//   GET/POST /iot/tokens · DELETE /iot/tokens/{id}   enrolment credentials
//   POST /iot/alerts/{id}/ack          acknowledge/reopen — ON THE GATEWAY
import { api } from "@/lib/api";
import type {
  IotAlertList,
  IotEnrollToken,
  IotGateway,
  IotGatewayList,
  IotMintedToken,
  IotPointList,
} from "./types";

export const iot = {
  gateways: {
    list: () => api.get<IotGatewayList>("/iot/gateways").then((r) => r.data),
    get: (id: string) => api.get<IotGateway>(`/iot/gateways/${id}`).then((r) => r.data),
    points: (id: string, limit = 500) =>
      api.get<IotPointList>(`/iot/gateways/${id}/points`, { params: { limit } }).then((r) => r.data),
    alerts: (id: string, limit = 100) =>
      api.get<IotAlertList>(`/iot/gateways/${id}/alerts`, { params: { limit } }).then((r) => r.data),
  },
  /**
   * Commands. Every one of these takes effect ON THE GATEWAY SERVER — this
   * platform stores no fleet state of its own, so there is nothing here to
   * update optimistically and the caller refetches instead.
   */
  approve: (gatewayId: string) => api.post(`/iot/gateways/${gatewayId}/approve`).then((r) => r.data),
  revoke: (gatewayId: string) => api.post(`/iot/gateways/${gatewayId}/revoke`).then((r) => r.data),
  tokens: {
    list: () => api.get<{ tokens: IotEnrollToken[] }>("/iot/tokens").then((r) => r.data.tokens),
    /**
     * Mint one. The plaintext comes back ONCE — the gateway server keeps only
     * a hash — so the caller must show it immediately and must not expect to
     * fetch it again. There is no "show it again" because there is nothing to
     * show.
     */
    mint: (name: string) => api.post<IotMintedToken>("/iot/tokens", { name }).then((r) => r.data),
    revoke: (id: string) => api.delete(`/iot/tokens/${id}`).then((r) => r.data),
  },
  alerts: {
    /**
     * Acknowledge or reopen. The write happens on the GATEWAY, which then
     * republishes the alert; our row changes when that message lands. So the
     * caller refetches rather than updating optimistically — an optimistic row
     * would show a state this platform invented, and the one case it gets
     * wrong is the one worth seeing.
     */
    ack: (alertId: string, acked: boolean) =>
      api.post(`/iot/alerts/${alertId}/ack`, { acked }).then((r) => r.data),
  },
};
