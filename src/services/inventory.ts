// Retail inventory: products the artist sells alongside services (lipsticks,
// skincare, kits, lash sets). Tracks stock, cost vs retail price for margin,
// and a low-stock threshold. Sales are logged separately so retail revenue can
// be reported and stock decrements are auditable.

export type Product = {
  productId: string;
  name: string;
  sku: string;
  price: number; // retail price (₹)
  cost: number; // cost price (₹), for margin
  stock: number;
  lowStockThreshold: number;
  category: string;
  status: "Active" | "Archived";
  createdAt: string;
};

export const productHeaders = [
  "Product ID",
  "Name",
  "SKU",
  "Price",
  "Cost",
  "Stock",
  "Low Stock Threshold",
  "Category",
  "Status",
  "Created At",
] as const;

export function parseProduct(row: string[]): Product {
  return {
    productId: row[0] || "",
    name: row[1] || "",
    sku: row[2] || "",
    price: Number(row[3]) || 0,
    cost: Number(row[4]) || 0,
    stock: Number(row[5]) || 0,
    lowStockThreshold: Number(row[6]) || 0,
    category: row[7] || "",
    status: (row[8] as Product["status"]) || "Active",
    createdAt: row[9] || "",
  };
}

export function productToRow(p: Product): string[] {
  return [
    p.productId,
    p.name,
    p.sku,
    String(p.price),
    String(p.cost),
    String(p.stock),
    String(p.lowStockThreshold),
    p.category,
    p.status,
    p.createdAt,
  ];
}

export function isLowStock(p: Product): boolean {
  return p.status === "Active" && p.lowStockThreshold > 0 && p.stock <= p.lowStockThreshold;
}

export type ProductSale = {
  saleId: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  total: number;
  clientWhatsApp: string;
  soldAt: string;
};

export const productSaleHeaders = [
  "Sale ID",
  "Product ID",
  "Product Name",
  "Quantity",
  "Unit Price",
  "Total",
  "Client WhatsApp",
  "Sold At",
] as const;

export function parseProductSale(row: string[]): ProductSale {
  return {
    saleId: row[0] || "",
    productId: row[1] || "",
    productName: row[2] || "",
    quantity: Number(row[3]) || 0,
    unitPrice: Number(row[4]) || 0,
    total: Number(row[5]) || 0,
    clientWhatsApp: row[6] || "",
    soldAt: row[7] || "",
  };
}

export function productSaleToRow(s: ProductSale): string[] {
  return [
    s.saleId,
    s.productId,
    s.productName,
    String(s.quantity),
    String(s.unitPrice),
    String(s.total),
    s.clientWhatsApp,
    s.soldAt,
  ];
}
