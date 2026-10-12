import type { AnalyzedProduct, AlternativeProduct, HarmfulIngredient, Nutrient } from "../types";

export interface RealtimeAnalysisResponse {
  success: boolean;
  isFoodProduct?: boolean;
  detectedObject?: string;
  message?: string;
  data?: AnalyzedProduct;
  detail?: string;
}

export type RealtimeScanResult =
  | {
      isFoodProduct: true;
      product: AnalyzedProduct;
    }
  | {
      isFoodProduct: false;
      detectedObject: string;
      message: string;
    };

export interface ProductSearchItem {
  name: string;
  brand: string;
  kcal?: number;
  grade?: "A" | "B" | "C" | "D" | "F";
  score?: number;
  image?: string;
  hasPalmOil?: boolean;
}

export async function analyzeProductRealtime(params: {
  query?: string;
  imageDataUrl?: string;
  ocrText?: string;
}): Promise<RealtimeScanResult> {
  const response = await fetch("/api/scan/realtime-analysis", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Realtime analysis failed (${response.status}): ${errorText}`);
  }

  const json: RealtimeAnalysisResponse = await response.json();
  if (!json.success) {
    throw new Error(json.detail || "Unable to retrieve real-time nutrition information for this product.");
  }

  if (json.isFoodProduct === false) {
    return {
      isFoodProduct: false,
      detectedObject: json.detectedObject || "Non-food item",
      message: json.message || "Not a food product. Please scan an edible food package, grocery item, or meal.",
    };
  }

  if (!json.data) {
    throw new Error("Missing product data in server response.");
  }

  return {
    isFoodProduct: true,
    product: json.data,
  };
}

export async function searchProductsRealtime(q: string): Promise<ProductSearchItem[]> {
  if (!q.trim()) return [];
  try {
    const res = await fetch(`/api/scan/search-products?q=${encodeURIComponent(q.trim())}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.products || [];
  } catch {
    return [];
  }
}

export async function askFoodAI(params: {
  product: AnalyzedProduct;
  userQuery: string;
  chatHistory?: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<string> {
  try {
    const res = await fetch("/api/ai/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      throw new Error(`AI assistant error (${res.status})`);
    }
    const data = await res.json();
    return data.answer || "I could not generate an answer at this time.";
  } catch (err: any) {
    return `Note: ${err.message || "Could not reach AI assistant"}. Please try asking again.`;
  }
}
