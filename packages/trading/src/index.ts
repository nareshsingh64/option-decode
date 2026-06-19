import type { PaperOrderRequest } from "@option-decode/types";
import { randomUUID } from "node:crypto";

export interface PaperOrder extends PaperOrderRequest {
  id: string;
  status: "PENDING" | "FILLED" | "CANCELLED" | "REJECTED";
  createdAt: string;
}

export function createPaperOrder(request: PaperOrderRequest, now = new Date()): PaperOrder {
  return {
    ...request,
    id: randomUUID(),
    status: "PENDING",
    createdAt: now.toISOString()
  };
}
