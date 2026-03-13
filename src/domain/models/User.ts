export type UserRole = "admin" | "user";

export interface User {
  id: number;
  phone?: string;
  username?: string;
  role: UserRole;
  planId?: string;
  assignedMenuIds: string[];
}

export interface PlanRequest {
  userId: number;
  username?: string;
  phone?: string;
  temporality?: string;
  requestedPlan: string;
  paymentMethod: string;
  timestamp: number;
  status: "pending" | "approved" | "rejected";
}
