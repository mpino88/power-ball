export interface Plan {
  id: string;
  title: string;
  description: string;
  price: string;
  menuIds: string; // Comma separated, or could be string[]
  price_1m: string;
  price_3m: string;
  price_6m: string;
  price_9m: string;
  price_1a: string;
  autoApprove?: boolean;
}
