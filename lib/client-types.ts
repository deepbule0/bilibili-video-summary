import type { Entitlement, PlanConfig } from "@/lib/commerce";

export type ApiMessage = { ok?: boolean; error?: string; testCode?: string };
export type AccountJob = {
  id: string; title: string; bvid: string; status: string;
  durationSeconds: number; chargedSeconds: number; createdAt: string;
};
export type AccountOrder = {
  id: string; planId: string; amountCents: number; status: string; createdAt: string;
};
export type AccountSnapshot = {
  user: { fullName: string | null; email: string; phone: string | null; role: string };
  entitlement: Entitlement; jobs: AccountJob[]; orders: AccountOrder[];
};
export type AdminSnapshot = {
  metrics: { users: number; payingUsers: number; revenueCents: number; processedMinutes: number; failedJobs: number };
  plans: PlanConfig[];
  recentJobs: (AccountJob & { email: string; priority: number })[];
  recentOrders: (AccountOrder & { email: string })[];
};
