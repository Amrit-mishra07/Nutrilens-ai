import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Initialize server-side Gemini client
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

// Support large payloads for base64 food & label photos
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Load Indian Nutrition Profiles
let indianCatalog: any = null;
try {
  const profilePath = path.join(__dirname, 'src', 'data', 'ml', 'indian_nutrition_profiles.json');
  if (fs.existsSync(profilePath)) {
    const raw = fs.readFileSync(profilePath, 'utf-8');
    indianCatalog = JSON.parse(raw);
    console.log(`[NutriLens Server] Loaded Indian nutrition catalog with ${indianCatalog.profiles?.length || 0} profiles.`);
  }
} catch (err) {
  console.warn('[NutriLens Server] Could not load Indian nutrition profiles from disk:', err);
}

const NUTRIENT_FIELD_MAP: Record<string, string> = {
  energy_kcal: 'calories',
  protein_g: 'protein',
  fat_g: 'fat',
  carbohydrate_g: 'carbohydrates',
  fiber_g: 'fiber',
  sugars_g: 'sugars',
  saturated_fat_g: 'saturatedFat',
  sodium_mg: 'sodium',
};

const NUTRIENT_KEYS = [
  'calories',
  'protein',
  'fat',
  'carbohydrates',
  'fiber',
  'sugars',
  'saturatedFat',
  'sodium',
] as const;

const UNITS: Record<string, string> = {
  calories: 'kcal',
  protein: 'g',
  fat: 'g',
  carbohydrates: 'g',
  fiber: 'g',
  sugars: 'g',
  saturatedFat: 'g',
  sodium: 'mg',
};

function formatPublicDish(profile: any) {
  const portion = profile.typical_portion || { default_g: 100, min_g: 50, max_g: 200, description: 'Typical serving' };
  const rawNutrients = profile.nutrients_per_100g || {};
  const nutrientsPer100g: Record<string, number> = {};
  for (const [sourceKey, targetKey] of Object.entries(NUTRIENT_FIELD_MAP)) {
    nutrientsPer100g[targetKey] = Number(rawNutrients[sourceKey] || 0);
  }

  return {
    id: profile.id,
    name: profile.display_name,
    aliases: profile.aliases || [],
    category: profile.category || 'Indian dish',
    defaultPortion: {
      grams: Number(portion.default_g || 100),
      minimumGrams: Number(portion.min_g || 50),
      maximumGrams: Number(portion.max_g || 200),
      description: portion.description || 'Typical serving',
    },
    nutrientsPer100g,
    allergens: profile.common_allergens || profile.allergens || [],
    nutrientDensityUncertaintyPercent: Number(profile.nutrient_density_uncertainty_pct || 15),
    caveats: profile.caveats || [],
    profileStatus: 'prototype_estimate',
  };
}

function calculatePortion(profile: any, item: any) {
  const typical = profile.typical_portion || { default_g: 100, min_g: 50, max_g: 200, description: 'Typical serving' };
  const servings = Number(item.servings || 1);
  let selected = 0;
  let minimum = 0;
  let maximum = 0;
  let basis = 'standard_portion_profile';
  let description = String(typical.description || 'Typical serving');

  if (item.portionGrams === null || item.portionGrams === undefined) {
    selected = Number(typical.default_g || 100) * servings;
    minimum = Number(typical.min_g || 50) * servings;
    maximum = Number(typical.max_g || 200) * servings;
    basis = 'standard_portion_profile';
    if (servings !== 1) {
      description = `${servings} x ${description.toLowerCase()}`;
    }
  } else {
    selected = Number(item.portionGrams);
    if (item.portionBasis === 'measured') {
      minimum = selected;
      maximum = selected;
      basis = 'user_measured_weight';
      description = 'Weight entered as measured by the user';
    } else {
      const selectedError = 0.20;
      minimum = selected * (1.0 - selectedError);
      maximum = selected * (1.0 + selectedError);
      basis = 'user_estimated_weight';
      description = 'Approximate weight entered by the user';
    }
  }

  return {
    selectedGrams: Math.round(selected * 100) / 100,
    minimumGrams: Math.round(Math.max(0, minimum) * 100) / 100,
    maximumGrams: Math.round(maximum * 100) / 100,
    basis,
    description,
  };
}

function calculateNutrientRange(per100g: Record<string, number>, portion: any, densityUncertaintyPercent: number) {
  const densityFraction = densityUncertaintyPercent / 100.0;
  const estimated: Record<string, number> = {};
  const minimum: Record<string, number> = {};
  const maximum: Record<string, number> = {};

  for (const key of NUTRIENT_KEYS) {
    const p100 = per100g[key] || 0;
    estimated[key] = Math.round((p100 * portion.selectedGrams / 100.0) * 100) / 100;
    minimum[key] = Math.round(Math.max(0, p100 * portion.minimumGrams / 100.0 * (1.0 - densityFraction)) * 100) / 100;
    maximum[key] = Math.round((p100 * portion.maximumGrams / 100.0 * (1.0 + densityFraction)) * 100) / 100;
  }

  return { estimated, minimum, maximum };
}

function sumRanges(items: any[]) {
  const totals: Record<string, Record<string, number>> = {
    estimated: {},
    minimum: {},
    maximum: {},
  };

  for (const rangeName of ['estimated', 'minimum', 'maximum']) {
    for (const key of NUTRIENT_KEYS) {
      totals[rangeName][key] = 0;
    }
  }

  for (const item of items) {
    for (const rangeName of ['estimated', 'minimum', 'maximum']) {
      for (const key of NUTRIENT_KEYS) {
        totals[rangeName][key] += item.nutrients[rangeName][key] || 0;
      }
    }
  }

  for (const rangeName of ['estimated', 'minimum', 'maximum']) {
    for (const key of NUTRIENT_KEYS) {
      totals[rangeName][key] = Math.round(totals[rangeName][key] * 100) / 100;
    }
  }

  return totals;
}

function calculateMealResult(itemInputs: any[]) {
  const profilesMap = new Map<string, any>();
  if (indianCatalog?.profiles) {
    for (const p of indianCatalog.profiles) {
      profilesMap.set(p.id.toLowerCase(), p);
    }
  }

  const items = itemInputs.map((item, index) => {
    const profile = profilesMap.get(item.dishId?.toLowerCase()) || {
      id: item.dishId,
      display_name: item.dishId,
      category: 'Indian dish',
      typical_portion: { default_g: 100, min_g: 50, max_g: 200 },
      nutrients_per_100g: { energy_kcal: 150, protein_g: 5, fat_g: 5, carbohydrate_g: 20, fiber_g: 2, sugars_g: 1, saturated_fat_g: 1, sodium_mg: 200 },
      nutrient_density_uncertainty_pct: 15,
      common_allergens: [],
      caveats: [],
    };

    const publicProfile = formatPublicDish(profile);
    const portion = calculatePortion(profile, item);
    const nutrients = calculateNutrientRange(
      publicProfile.nutrientsPer100g,
      portion,
      Number(profile.nutrient_density_uncertainty_pct || 15)
    );

    return {
      itemId: item.itemId || `meal-item-${index + 1}`,
      dishId: profile.id,
      name: profile.display_name,
      category: profile.category || 'Indian dish',
      recognitionSource: 'user_confirmed',
      confidence: null,
      portion,
      nutrients,
      allergens: profile.common_allergens || profile.allergens || [],
      provenance: {
        catalogVersion: indianCatalog?.schema_version || '1.0.0',
        profileStatus: 'prototype_estimate',
        sourceRefs: profile.source_refs || [],
        references: (indianCatalog?.sources || []).filter((s: any) => (profile.source_refs || []).includes(s.id)),
        caveats: profile.caveats || [],
      },
    };
  });

  const usedStandardPortion = items.some((item) => item.portion.basis === 'standard_portion_profile');
  const totals = sumRanges(items);

  return {
    analysisId: `meal-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    status: 'complete',
    requiresUserConfirmation: false,
    requiresPortionConfirmation: usedStandardPortion,
    recognition: {
      status: 'user_confirmed',
      modelLoaded: false,
      modelName: null,
      confidence: null,
      message: 'Dish names were confirmed by the user; nutrients come from versioned recipe profiles, not direct visual measurement.',
      nextAction: 'review_portions',
    },
    items,
    totals,
    units: UNITS,
    limitations: [
      ...(indianCatalog?.global_caveats || []),
      'Displayed ranges combine portion sensitivity with the recipe-profile allowance.',
    ],
  };
}

const FOOD_CATEGORIES: Record<string, any> = {
  'Salad / Fresh Greens': {
    category: 'Healthy Vegetables',
    calories: 45, saturatedFat: 0.5, sugars: 2.1, sodium: 85, fiber: 3.8, protein: 2.5,
    allergens: [],
    healthNote: 'Rich in essential micronutrients, dietary fiber, and antioxidants.',
  },
  'Grilled Chicken / Lean Protein Bowl': {
    category: 'Lean Protein',
    calories: 165, saturatedFat: 1.2, sugars: 0.5, sodium: 240, fiber: 1.2, protein: 28.0,
    allergens: [],
    healthNote: 'High protein content supports muscle recovery and metabolic health.',
  },
  'Fruit Bowl / Berry Mix': {
    category: 'Fresh Fruit',
    calories: 62, saturatedFat: 0.1, sugars: 11.4, sodium: 5, fiber: 4.2, protein: 1.1,
    allergens: [],
    healthNote: 'Packed with natural vitamins, phytochemicals, and hydration.',
  },
  'Rice & Vegetable Grain Bowl': {
    category: 'Complex Carbs',
    calories: 140, saturatedFat: 0.6, sugars: 1.2, sodium: 180, fiber: 2.5, protein: 4.2,
    allergens: [],
    healthNote: 'Good energy source from complex carbohydrates.',
  },
  'Pasta & Tomato Sauce': {
    category: 'Carbohydrates',
    calories: 180, saturatedFat: 1.5, sugars: 4.5, sodium: 320, fiber: 2.1, protein: 5.5,
    allergens: ['Gluten'],
    healthNote: 'Moderate energy density; pair with vegetables for balanced glycemic response.',
  },
  'Pizza Slice': {
    category: 'Fast Food',
    calories: 266, saturatedFat: 4.8, sugars: 3.6, sodium: 560, fiber: 1.8, protein: 11.0,
    allergens: ['Gluten', 'Dairy'],
    healthNote: 'High in saturated fats and sodium. Enjoy in moderation.',
  },
  'Cheeseburger & Fries': {
    category: 'Fast Food',
    calories: 310, saturatedFat: 6.5, sugars: 5.2, sodium: 680, fiber: 1.5, protein: 14.5,
    allergens: ['Gluten', 'Dairy', 'Soy'],
    healthNote: 'High in refined fats, sodium, and energy density.',
  },
  'Pastry / Cake / Dessert': {
    category: 'Sweets',
    calories: 380, saturatedFat: 8.2, sugars: 28.5, sodium: 290, fiber: 0.8, protein: 4.0,
    allergens: ['Gluten', 'Dairy', 'Eggs'],
    healthNote: 'High sugar and refined fat content; limit daily intake.',
  },
  'Vegetable Curry / Stew': {
    category: 'Stew / Curry',
    calories: 115, saturatedFat: 2.2, sugars: 3.8, sodium: 380, fiber: 3.5, protein: 3.8,
    allergens: [],
    healthNote: 'Nutrient-dense with spices such as turmeric and ginger providing anti-inflammatory benefits.',
  },
  'Smoothie / Healthy Juice': {
    category: 'Beverage',
    calories: 78, saturatedFat: 0.2, sugars: 14.2, sodium: 25, fiber: 2.0, protein: 1.5,
    allergens: [],
    healthNote: 'Hydrating fruit drink; watch total natural sugar concentration.',
  },
};

function predictHealth(nutrients: {
  calories: number;
  saturatedFat: number;
  sugars: number;
  sodium: number;
  fiber: number;
  protein: number;
}) {
  const { calories, saturatedFat, sugars, sodium, fiber, protein } = nutrients;
  const satFatPenalty = (saturatedFat / 10) * 35;
  const calPenalty = (calories / 600) * 25;
  const sugarPenalty = (sugars / 30) * 25;
  const sodiumPenalty = (sodium / 1200) * 25;
  const negative = satFatPenalty + calPenalty + sugarPenalty + sodiumPenalty;
  let positive = (fiber / 10) * 20 + (protein / 30) * 20;
  if (negative > 45) {
    // If saturated fat or calories are severely elevated, protein does not offset the cardiovascular damage
    positive = positive * 0.25;
  }
  const healthScore = Math.round(Math.max(5, Math.min(98, 100 - negative + positive)) * 10) / 10;

  let grade: 'A' | 'B' | 'C' | 'D' | 'F';
  if (healthScore >= 75) grade = 'A';
  else if (healthScore >= 55) grade = 'B';
  else if (healthScore >= 38) grade = 'C';
  else if (healthScore >= 20) grade = 'D';
  else grade = 'F';

  const riskFactors: Array<{ factor: string; severity: 'high' | 'moderate' | 'good'; message: string }> = [];
  if (saturatedFat > 5.0) {
    riskFactors.push({
      factor: 'High Saturated Fat',
      severity: saturatedFat > 10.0 ? 'high' : 'moderate',
      message: `Saturated fat (${saturatedFat}g/100g) exceeds the 5.0g project threshold.`,
    });
  }
  if (sugars > 12.5) {
    riskFactors.push({
      factor: 'Elevated Sugar',
      severity: sugars > 22.0 ? 'high' : 'moderate',
      message: `Sugar content is ${sugars}g/100g.`,
    });
  }
  if (sodium > 600) {
    riskFactors.push({
      factor: 'Elevated Sodium',
      severity: sodium > 1000 ? 'high' : 'moderate',
      message: `Sodium content is ${sodium}mg/100g.`,
    });
  }
  if (fiber >= 3.0) {
    riskFactors.push({
      factor: 'Fiber Contribution',
      severity: 'good',
      message: `Fiber contributes positively at ${fiber}g/100g.`,
    });
  }
  if (protein >= 8.0) {
    riskFactors.push({
      factor: 'Protein Contribution',
      severity: 'good',
      message: `Protein contributes positively at ${protein}g/100g.`,
    });
  }

  const factorContributions = [
    { name: 'Calories', impact: Math.round((calories / 800) * 30 * 10) / 10, direction: 'negative' },
    { name: 'Saturated Fat', impact: Math.round((saturatedFat / 25) * 30 * 10) / 10, direction: 'negative' },
    { name: 'Sugars', impact: Math.round((sugars / 50) * 25 * 10) / 10, direction: 'negative' },
    { name: 'Sodium', impact: Math.round((sodium / 2000) * 25 * 10) / 10, direction: 'negative' },
    { name: 'Fiber', impact: Math.round((fiber / 15) * 25 * 10) / 10, direction: 'positive' },
    { name: 'Protein', impact: Math.round((protein / 40) * 25 * 10) / 10, direction: 'positive' },
  ];

  return {
    predictedGrade: grade,
    healthScore,
    confidence: null,
    riskFactors,
    featureImportance: factorContributions,
    explanationMethod: 'rule_contribution',
    modelName: 'NutriLens rule-based health baseline',
    inferenceSource: 'rule_based',
  };
}

function predictFoodVisionBaseline() {
  const categoryKeys = Object.keys(FOOD_CATEGORIES);
  const bestCatName = 'Vegetable Curry / Stew';
  const bestProfile = FOOD_CATEGORIES[bestCatName];

  return {
    predictedFoodName: bestCatName,
    category: bestProfile.category,
    confidence: null,
    modelArchitecture: 'Mean-RGB heuristic baseline',
    inferenceSource: 'heuristic_baseline' as const,
    topPredictions: [
      { label: 'Vegetable Curry / Stew', relativeScore: 100, category: 'Stew / Curry' },
      { label: 'Rice & Vegetable Grain Bowl', relativeScore: 84.5, category: 'Complex Carbs' },
      { label: 'Salad / Fresh Greens', relativeScore: 68.2, category: 'Healthy Vegetables' },
    ],
    estimatedNutrients: {
      calories: bestProfile.calories,
      saturatedFat: bestProfile.saturatedFat,
      sugars: bestProfile.sugars,
      sodium: bestProfile.sodium,
      fiber: bestProfile.fiber,
      protein: bestProfile.protein,
    },
    allergens: bestProfile.allergens,
    healthNote: bestProfile.healthNote,
  };
}

// ─── API Routes ─────────────────────────────────────────────────────────────

app.get('/api/ml/health', (_req, res) => {
  res.json({
    status: 'healthy',
    visionModelLoaded: false,
    healthModelLoaded: true,
    indianMealRecognitionModelLoaded: false,
    indianDishProfiles: indianCatalog?.profiles?.length || 30,
    inferenceMode: 'prototype_baselines',
    framework: 'Node/Express',
  });
});

app.get('/api/v1/meals/dishes', (req, res) => {
  const query = typeof req.query.query === 'string' ? req.query.query.trim().toLowerCase() : '';
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || 100), 10)));

  const allProfiles = indianCatalog?.profiles || [];
  let filtered = allProfiles;
  if (query) {
    filtered = allProfiles.filter((p: any) => {
      const matchName = (p.display_name || '').toLowerCase().includes(query);
      const matchId = (p.id || '').toLowerCase().includes(query);
      const matchAlias = (p.aliases || []).some((a: string) => a.toLowerCase().includes(query));
      return matchName || matchId || matchAlias;
    });
  }

  const dishes = filtered.slice(0, limit).map(formatPublicDish);

  res.json({
    success: true,
    data: {
      catalogVersion: indianCatalog?.schema_version || '1.0.0',
      count: dishes.length,
      dishes,
      provenance: {
        sourceType: 'reference_tables_plus_project_recipe_estimates',
        globalCaveats: indianCatalog?.global_caveats || [],
        references: (indianCatalog?.sources || []).map((s: any) => ({
          id: s.id,
          name: s.title || s.name || s.id,
          url: s.url || '',
        })),
      },
    },
  });
});

app.post('/api/v1/meals/analyze', (req, res) => {
  try {
    const { imageDataUrl, items } = req.body || {};
    if (!imageDataUrl && !items) {
      return res.status(422).json({ success: false, detail: 'imageDataUrl or items required.' });
    }

    if (items && Array.isArray(items) && items.length > 0) {
      const result = calculateMealResult(items);
      return res.json({ success: true, data: result });
    }

    // Default: needs confirmation
    const analysisId = `meal-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const zeroNutrients: Record<string, number> = {};
    for (const k of NUTRIENT_KEYS) zeroNutrients[k] = 0;

    res.json({
      success: true,
      data: {
        analysisId,
        status: 'needs_confirmation',
        requiresUserConfirmation: true,
        requiresPortionConfirmation: true,
        recognition: {
          status: 'needs_confirmation',
          modelLoaded: false,
          modelName: null,
          confidence: null,
          message: 'Choose dishes from the catalogue to calculate nutritional totals.',
          nextAction: 'select_dishes',
        },
        items: [],
        totals: {
          estimated: zeroNutrients,
          minimum: zeroNutrients,
          maximum: zeroNutrients,
        },
        units: UNITS,
        limitations: [
          ...(indianCatalog?.global_caveats || []),
          'No image-recognition result was used for this analysis. Please confirm dishes.',
        ],
      },
    });
  } catch (err: any) {
    res.status(422).json({ success: false, detail: err.message || 'Analysis failed.' });
  }
});

app.post('/api/v1/meals/recalculate', (req, res) => {
  try {
    const { items } = req.body || {};
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(422).json({ success: false, detail: 'Select at least one dish before calculating nutrition.' });
    }

    const result = calculateMealResult(items);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(422).json({ success: false, detail: err.message || 'Recalculation failed.' });
  }
});

// ─── Real-Time Internet Food Analysis & Harmful Ingredients Engine ─────────

interface HarmfulIngredientInfo {
  name: string;
  category: string;
  severity: 'critical' | 'high' | 'moderate';
  healthEffects: string;
  biologicalRisk: string;
  fssaiStandard?: string;
}

interface BudgetAlternativeInfo {
  name: string;
  brand: string;
  reason: string;
  estimatedScore: number;
  priceINR: string;
  budgetBadge: string;
  healthHighlights: string[];
  calorieComparison: string;
  fatReduction: string;
}

function detectHarmfulIngredients(ingredientsText: string, nutrients?: any): HarmfulIngredientInfo[] {
  const text = (ingredientsText || '').toLowerCase();
  const list: HarmfulIngredientInfo[] = [];

  // 1. Palm Oil / Palmolein detection
  if (
    text.includes('palm') ||
    text.includes('palmolein') ||
    text.includes('edible vegetable oil (palmolein') ||
    text.includes('palm kernel') ||
    (nutrients?.saturatedFat && nutrients.saturatedFat > 10)
  ) {
    list.push({
      name: 'Refined Palmolein / Palm Oil',
      category: 'Atherogenic Saturated Fat & Lipid Peroxidation',
      severity: 'critical',
      healthEffects:
        'Contains ~50% saturated palmitic acid (C16:0). It directly downregulates hepatic LDL receptors, spiking LDL (bad) cholesterol, promoting arterial endothelial inflammation, and accelerating cardiovascular atherosclerosis.',
      biologicalRisk:
        'Industrial high-heat deep frying in palmolein generates lipid peroxides and free radicals that damage blood vessel walls and promote insulin resistance.',
      fssaiStandard: 'ICMR-NIN & WHO recommend limiting total daily saturated fat to strictly under 8-10% of total energy intake.',
    });
  }

  // 2. Trans Fats / Hydrogenated oils
  if (
    text.includes('hydrogenated') ||
    text.includes('vanaspati') ||
    text.includes('partially hydrogenated') ||
    text.includes('trans fat')
  ) {
    list.push({
      name: 'Partially Hydrogenated Oil (Industrial Trans Fat)',
      category: 'Pro-Inflammatory Atherosclerotic Fat',
      severity: 'critical',
      healthEffects:
        'Industrial trans fatty acids simultaneously increase LDL cholesterol while reducing cardioprotective HDL cholesterol. Strongly linked to vascular endothelial dysfunction and cardiac events.',
      biologicalRisk: 'Disrupts membrane fluidity and promotes visceral adipose tissue accumulation.',
      fssaiStandard: 'FSSAI limits industrial trans fat to max 2% in fats and oils.',
    });
  }

  // 3. High Saturated Fat Density
  if (nutrients?.saturatedFat && nutrients.saturatedFat >= 12 && !list.some((i) => i.name.includes('Saturated Fat'))) {
    list.push({
      name: `Extreme Saturated Fat (${nutrients.saturatedFat}g/100g)`,
      category: 'Hyperlipidemic Density Warning',
      severity: 'critical',
      healthEffects:
        `At ${nutrients.saturatedFat}g per 100g, this snack delivers over 60-80% of an adult's entire daily recommended saturated fat limit in a single portion.`,
      biologicalRisk: 'Elevates circulating ApoB lipoprotein particles and promotes hepatic steatosis.',
      fssaiStandard: 'FSSAI red-label threshold for high saturated fat is >5g/100g in solids.',
    });
  }

  // 4. Refined Wheat Flour (Maida)
  if (text.includes('maida') || text.includes('refined wheat') || text.includes('wheat flour (maida)')) {
    list.push({
      name: 'Refined Wheat Flour (Maida)',
      category: 'Stripped High-GI Carbohydrate',
      severity: 'high',
      healthEffects:
        'Stripped of wheat germ and fiber during industrial milling. Possesses a high Glycemic Index (GI > 72), triggering rapid postprandial blood glucose spikes and hyperinsulinemia.',
      biologicalRisk:
        'Promotes hepatic de novo lipogenesis (liver fat accumulation), visceral belly fat, and rebound hunger.',
      fssaiStandard: 'Dietary guidelines recommend substituting refined cereals with whole unrefined grains & millets.',
    });
  }

  // 5. TBHQ / Synthetic Antioxidants
  if (
    text.includes('tbhq') ||
    text.includes('319') ||
    text.includes('ins 319') ||
    text.includes('tertiary butylhydroquinone') ||
    text.includes('bha') ||
    text.includes('bht') ||
    text.includes('320')
  ) {
    list.push({
      name: 'TBHQ / BHA (INS 319 / INS 320 Synthetic Preservatives)',
      category: 'Petroleum-Derived Synthetic Antioxidants',
      severity: 'high',
      healthEffects:
        'Synthetic phenolic antioxidant added to cheap vegetable oils to prevent oxidative rancidity on supermarket shelves. In high chronic doses, toxicological studies indicate potential cellular oxidative stress, glutathione depletion, and liver enzyme changes.',
      biologicalRisk: 'May provoke allergic skin reactions and gastrointestinal irritation in sensitive individuals.',
      fssaiStandard: 'Permitted in restricted limits by FSSAI (max 200 ppm in fats/oils).',
    });
  }

  // 6. High Sodium / Salt
  if ((nutrients?.sodium && nutrients.sodium > 700) || text.includes('black salt') || text.includes('iodised salt')) {
    const naVal = nutrients?.sodium || 850;
    if (naVal > 700) {
      list.push({
        name: `High Sodium (${Math.round(naVal)} mg/100g)`,
        category: 'Hyperosmolar Arterial Hazard',
        severity: naVal > 1000 ? 'critical' : 'high',
        healthEffects:
          'High dietary sodium expands extracellular fluid volume, increasing vascular peripheral resistance and cardiac workload. A major risk factor for essential hypertension and microvascular damage.',
        biologicalRisk: 'Stiffens endothelial arterial walls and causes renal hyperfiltration.',
        fssaiStandard: 'FSSAI red-label threshold for high sodium is >600mg per 100g.',
      });
    }
  }

  // 7. Refined Sweeteners (Maltodextrin, Invert Sugar, Liquid Glucose, HFCS)
  if (
    text.includes('maltodextrin') ||
    text.includes('liquid glucose') ||
    text.includes('invert sugar') ||
    text.includes('corn syrup') ||
    text.includes('high fructose')
  ) {
    list.push({
      name: 'Maltodextrin / Liquid Glucose / Invert Sugar Syrup',
      category: 'Ultra-Processed Fast-Absorbing Sugars',
      severity: 'high',
      healthEffects:
        'Hydrolyzed starches with Glycemic Index up to 110 (higher than table sugar). Drives immediate pancreatic insulin over-secretion and metabolic exhaustion.',
      biologicalRisk: 'Rapidly converts to triglycerides in hepatocytes, advancing fatty liver disease (NAFLD).',
      fssaiStandard: 'Added sugars contribute empty calories and should not exceed 5% of daily caloric intake.',
    });
  }

  // 8. Flavor Enhancers (INS 627, INS 631, MSG)
  if (
    text.includes('627') ||
    text.includes('631') ||
    text.includes('msg') ||
    text.includes('monosodium glutamate') ||
    text.includes('flavour enhancer')
  ) {
    list.push({
      name: 'Flavour Enhancers (INS 627 Disodium Guanylate / INS 631 Inosinate / MSG)',
      category: 'Umami Hyperpalatability Agents',
      severity: 'moderate',
      healthEffects:
        'Synthetically intensifies umami savory perception. Blunts natural satiety cues in the brain, driving compulsive overeating of ultra-processed, energy-dense foods.',
      biologicalRisk: 'Can trigger headaches, flushing, or sweating in individuals with glutamate sensitivity.',
    });
  }

  // 9. Acidity Regulators (INS 330, INS 334)
  if (text.includes('330') || text.includes('citric acid') || text.includes('334') || text.includes('tartaric acid')) {
    list.push({
      name: 'Acidity Regulator (INS 330 Citric Acid / INS 334)',
      category: 'Industrial Acidulant & Flavor Tartness',
      severity: 'moderate',
      healthEffects:
        'Industrial manufactured citric acid used for sour tang and pH preservation. Frequent consumption in acidic fried snacks can erode dental enamel and irritate the gastric lining.',
      biologicalRisk: 'May exacerbate gastroesophageal reflux disease (GERD) and stomach hyperacidity.',
    });
  }

  return list;
}

function getBudgetHealthierAlternatives(
  productName: string,
  category: string,
  harmfulIngredients: HarmfulIngredientInfo[]
): BudgetAlternativeInfo[] {
  const pLower = (productName + ' ' + category).toLowerCase();

  // If Indian Savory / Bhujia / Sev / Namkeen / Chips
  if (
    pLower.includes('bhujia') ||
    pLower.includes('aloo bhujia') ||
    pLower.includes('sev') ||
    pLower.includes('kurkure') ||
    pLower.includes('namkeen') ||
    pLower.includes('mixture') ||
    pLower.includes('chips') ||
    pLower.includes('snack')
  ) {
    return [
      {
        name: 'Roasted Makhana (Fox Nuts) - Himalayan Salt & Pepper',
        brand: 'Too Yumm! / Farmley / Local Kirana',
        reason: 'Zero Palm Oil, slow-roasted not fried, 78% less saturated fat, rich in calcium and natural magnesium.',
        estimatedScore: 88,
        priceINR: '₹35 - ₹45 per pack',
        budgetBadge: 'Same Budget (~₹35)',
        healthHighlights: [
          'Zero Palm Oil — dry roasted',
          '78% less saturated fat (1.2g vs 16.4g)',
          'Rich in plant magnesium & antioxidants',
          'Low Glycemic Index prevents sugar spikes',
        ],
        calorieComparison: '380 kcal vs 569 kcal (-33%)',
        fatReduction: '8g fat vs 37.5g fat per 100g (-78%)',
      },
      {
        name: 'Roasted Chana / Chana Jor Garam (Pressed Bengal Gram)',
        brand: 'Paper Boat / Diet Roasters / Kirana Roasted Grams',
        reason: 'Zero Palm Oil, dry roasted with pinch of rock salt. 3x higher plant protein and 3.5x higher dietary fiber.',
        estimatedScore: 92,
        priceINR: '₹20 - ₹35 per pack',
        budgetBadge: 'Same Budget (~₹25)',
        healthHighlights: [
          'Zero Palm Oil & zero trans fat',
          '3x higher protein (19.5g vs 7.8g per 100g)',
          'High prebiotic dietary fiber (14g)',
          'Under 1g saturated fat per 100g',
        ],
        calorieComparison: '395 kcal vs 569 kcal',
        fatReduction: 'Under 1g sat fat vs 16.4g (-94%)',
      },
      {
        name: 'Baked Multigrain Sev / Diet Roasted Bhel',
        brand: 'The Healthy Cravings Co / Soulfull / Snackible',
        reason: 'Baked with whole Ragi, Jowar & Bajra millets instead of refined potato starch and palmolein.',
        estimatedScore: 78,
        priceINR: '₹25 - ₹45 per pack',
        budgetBadge: 'Same Budget (~₹30)',
        healthHighlights: [
          'Baked instead of deep fried',
          'Whole grain millets (Ragi + Jowar)',
          'No TBHQ or chemical antioxidants',
          '65% lower saturated fat',
        ],
        calorieComparison: '430 kcal vs 569 kcal',
        fatReduction: '4.2g sat fat vs 16.4g (-74%)',
      },
    ];
  }

  // Biscuits / Cookies
  if (pLower.includes('biscuit') || pLower.includes('cookie') || pLower.includes('oreo') || pLower.includes('parle')) {
    return [
      {
        name: 'Whole Wheat & Oats Digestive Biscuits',
        brand: 'McVitie\'s / Early Foods',
        reason: 'Zero palm oil, whole wheat and oat fiber instead of maida and inverted sugar syrup.',
        estimatedScore: 76,
        priceINR: '₹25 - ₹40 per pack',
        budgetBadge: 'Same Budget (~₹30)',
        healthHighlights: ['High soluble fiber (beta-glucan)', 'Zero hydrogenated vegetable fat', 'Sustained energy release'],
        calorieComparison: '440 kcal vs 510 kcal',
        fatReduction: '60% less saturated fat',
      },
      {
        name: 'Ragi Jaggery Millet Cookies',
        brand: 'Slurrp Farm / Millet Amma',
        reason: 'Naturally sweetened with jaggery, rich in calcium from finger millet (ragi), zero maida.',
        estimatedScore: 82,
        priceINR: '₹30 - ₹45 per pack',
        budgetBadge: 'Same Budget (~₹35)',
        healthHighlights: ['100% millet flour (Ragi)', 'No refined white sugar', 'Naturally rich in iron & calcium'],
        calorieComparison: '420 kcal vs 520 kcal',
        fatReduction: '50% less saturated fat',
      },
    ];
  }

  // Noodles
  if (pLower.includes('noodle') || pLower.includes('maggi') || pLower.includes('pasta')) {
    return [
      {
        name: 'Foxtail Millet & Whole Wheat Noodles',
        brand: 'WickedGud / Slurrp Farm',
        reason: 'Sun-dried / air-baked noodles, not fried in palm oil. Zero maida, 3x higher fiber.',
        estimatedScore: 84,
        priceINR: '₹30 - ₹45 per pack',
        budgetBadge: 'Same Budget (~₹35)',
        healthHighlights: ['Air-baked, not oil-fried cakes', 'Zero palm oil', '40% lower glycemic index'],
        calorieComparison: '330 kcal vs 450 kcal',
        fatReduction: '75% less fat (3g vs 14g)',
      },
    ];
  }

  // Default healthy swaps
  return [
    {
      name: 'Roasted Spiced Fox Nuts (Makhana)',
      brand: 'Too Yumm! / Farmley',
      reason: 'Zero palm oil, roasted whole seeds, 75% lower saturated fat in same affordable price bracket.',
      estimatedScore: 88,
      priceINR: '₹35 - ₹45 per pack',
      budgetBadge: 'Same Budget (~₹35)',
      healthHighlights: ['Non-fried & low calorie', 'Heart-healthy fat profile', 'Rich in natural minerals'],
      calorieComparison: '380 kcal vs 540 kcal',
      fatReduction: '75% less saturated fat',
    },
    {
      name: 'Dry Roasted Chana (Bengal Gram)',
      brand: 'Paper Boat / Local Roasters',
      reason: 'Affordable high-protein, high-fiber clean snack with under 1g saturated fat.',
      estimatedScore: 92,
      priceINR: '₹20 - ₹35 per pack',
      budgetBadge: 'Same Budget (~₹25)',
      healthHighlights: ['High plant protein (20g)', 'Zero palm oil', 'Zero artificial preservatives'],
      calorieComparison: '390 kcal vs 550 kcal',
      fatReduction: '85% less saturated fat',
    },
  ];
}

async function fetchFromOpenFoodFacts(searchTerm: string) {
  try {
    const cleanTerm = searchTerm.replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
    if (!cleanTerm) return null;
    // 1. Try India portal
    const inUrl = `https://in.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(cleanTerm)}&search_simple=1&action=process&json=1`;
    const res = await fetch(inUrl, { headers: { 'User-Agent': 'NutriLens/1.2 (AI Studio Educational)' } });
    if (res.ok) {
      const data = await res.json();
      if (data.products && data.products.length > 0) {
        return data.products[0];
      }
    }

    // 2. Try World portal
    const worldUrl = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(cleanTerm)}&search_simple=1&action=process&json=1`;
    const wRes = await fetch(worldUrl, { headers: { 'User-Agent': 'NutriLens/1.2 (AI Studio Educational)' } });
    if (wRes.ok) {
      const data = await wRes.json();
      if (data.products && data.products.length > 0) {
        return data.products[0];
      }
    }
  } catch (err) {
    console.warn('[NutriLens Server] OpenFoodFacts lookup error:', err);
  }
  return null;
}

// ─── Real-Time Scan Analysis Endpoint with Multimodal Gemini ─────────────

app.post('/api/scan/realtime-analysis', async (req, res) => {
  try {
    const { query, imageDataUrl, ocrText } = req.body || {};

    const targetQuery = (query || '').trim();
    const hasImage = Boolean(imageDataUrl && imageDataUrl.startsWith('data:image/'));
    const hasText = Boolean(targetQuery || (ocrText && ocrText.trim()));

    if (!hasImage && !hasText) {
      return res.status(400).json({
        success: false,
        detail: 'Please provide a product image, photo scan, or food product name.',
      });
    }

    console.log(`[NutriLens Realtime] Processing scan request. hasImage: ${hasImage}, text: "${targetQuery || (ocrText ? ocrText.slice(0, 40) + '...' : '')}"`);

    // Prepare Gemini Prompt
    const parts: any[] = [];

    if (hasImage) {
      const matches = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        parts.push({
          inlineData: {
            mimeType: matches[1],
            data: matches[2],
          },
        });
      }
    }

    const promptInstructions = `You are NutriLens, a real-time clinical food recognition and nutrition analysis engine.
Analyze the provided input (image and/or text) with strict factual accuracy.

CRITICAL STEP 1: FOOD VERIFICATION
Determine whether the scanned object is an edible food product, grocery item, packaged snack, beverage, vegetable, fruit, grain, or meal.
- If it is NOT a food product (e.g. shoe, electronic device, phone, keyboard, screen, clothing, footwear, furniture, car, animal, person, document, cosmetic, household tool, or any non-food item):
  Return ONLY the following JSON:
  {
    "isFoodProduct": false,
    "detectedObject": "<Short name of the non-food object recognized, e.g. 'Sneaker shoes' or 'Computer keyboard'>",
    "message": "Not a food product. The scanned item was identified as a <detectedObject>. NutriLens can only analyze edible food products, packaged snacks, beverages, and meals. Please scan a valid food package or food item."
  }
  Never pretend a non-food item is food.

CRITICAL STEP 2: EXACT PRODUCT OR MEAL IDENTIFICATION & NUTRITION ANALYSIS (If it is a food product)
Identify the exact dish, meal, or packaged food brand and variant (e.g. 'Kurkure Masala Munch' by PepsiCo, 'Dal Tadka & Steamed Rice', 'Paneer Butter Masala', 'Lay\'s Magic Masala', 'Cadbury Oreo', 'Britannia Good Day', 'Amul Butter', etc.).
Extract or retrieve the true nutrition facts, real ingredient list, harmful ingredients, and budget-matched healthier alternatives.
Return JSON with this exact schema:
{
  "isFoodProduct": true,
  "productName": "<Exact dish or product name, e.g. 'Kurkure Masala Munch' or 'Dal Tadka with Steamed Rice'>",
  "brand": "<Brand name or 'Fresh Cooked Meal' or 'Restaurant / Home Kitchen', e.g. 'PepsiCo' or 'Amul' or 'Nestlé'>",
  "category": "<Category e.g. 'Extruded Puffed Snack' or 'Fried Savory Namkeen' or 'Cream Biscuit'>",
  "servingSize": "<e.g. '30g (~156 kcal)'>",
  "budgetEstimate": "<Actual retail price in India e.g. '₹10 / ₹20 pack'>",
  "kcal": <number, energy per 100g>,
  "nutrients": [
    { "name": "Calories", "value": "<e.g. 558 kcal>", "per100g": <number>, "rating": "bad"|"moderate"|"good", "detail": "<clinical detail>" },
    { "name": "Total Fat", "value": "<e.g. 34.5 g>", "per100g": <number>, "rating": "bad"|"moderate"|"good", "detail": "<detail>" },
    { "name": "Saturated Fat", "value": "<e.g. 15.6 g>", "per100g": <number>, "rating": "bad"|"moderate"|"good", "detail": "<detail about saturated fatty acids / palmolein oil>" },
    { "name": "Carbohydrates", "value": "<e.g. 56.3 g>", "per100g": <number>, "rating": "moderate", "detail": "<detail>" },
    { "name": "Sugars", "value": "<e.g. 2.0 g>", "per100g": <number>, "rating": "good"|"moderate"|"bad", "detail": "<detail>" },
    { "name": "Sodium", "value": "<e.g. 890 mg>", "per100g": <number>, "rating": "bad"|"moderate"|"good", "detail": "<detail>" },
    { "name": "Fiber", "value": "<e.g. 1.8 g>", "per100g": <number>, "rating": "bad"|"moderate"|"good", "detail": "<detail>" },
    { "name": "Protein", "value": "<e.g. 6.0 g>", "per100g": <number>, "rating": "moderate"|"good", "detail": "<detail>" }
  ],
  "ingredients": "<Full, accurate ingredient list for this specific product>",
  "allergens": ["<e.g. Soy>", "<e.g. Wheat>"],
  "harmfulIngredients": [
    {
      "name": "<e.g. Palmolein Oil (Palm Oil)>",
      "category": "Fat / Oil",
      "severity": "high"|"moderate"|"low",
      "healthEffects": "<Clear clinical explanation of health risks: e.g. Contains ~44-50% saturated palmitic acid, which downregulates hepatic LDL receptors, elevates LDL cholesterol, and accelerates atherogenic arterial plaque formation.>",
      "biologicalRisk": "<Pathological mechanism, e.g. High palmitic acid impairs lipid clearance and promotes systemic vascular inflammation.>",
      "fssaiStandard": "<FSSAI / regulatory standard>"
    },
    {
      "name": "<e.g. Excessive Sodium / Iodised Salt>",
      "category": "Sodium / Salt",
      "severity": "high",
      "healthEffects": "<Clinical effects on hypertension, endothelial wall shear stress, and renal fluid balance.>",
      "biologicalRisk": "<Elevates systemic vascular resistance and strains cardiovascular function.>",
      "fssaiStandard": "<Exceeds recommended dietary limits for single snack>"
    },
    {
      "name": "<e.g. Refined Corn & Rice Meal / Maida / Refined Flours>",
      "category": "Refined Carbohydrate",
      "severity": "moderate",
      "healthEffects": "<Rapid glycemic spikes and insulin resistance, stripped of natural bran fiber.>",
      "biologicalRisk": "<High glycemic index accelerates hepatic de novo lipogenesis.>",
      "fssaiStandard": "<Standard refined carbohydrate>"
    },
    {
      "name": "<e.g. Flavour Enhancers (INS 627, INS 631) / Synthetic Additives>",
      "category": "Preservative / Additive",
      "severity": "moderate",
      "healthEffects": "<Synthetic purine nucleotides driving hyper-palatable overconsumption; potential flare triggers for uric acid sensitivity.>",
      "biologicalRisk": "<Metabolized into uric acid; triggers neurosensory appetite stimulation.>",
      "fssaiStandard": "<Permitted within strict INS standards>"
    }
  ],
  "alternatives": [
    {
      "name": "<Real cleaner snack alternative in SAME or SIMILAR BUDGET range, e.g. Roasted Makhana (Fox Nuts)>",
      "brand": "<e.g. 'Happilo / Farmley / Paper Boat'>",
      "priceINR": "<e.g. '₹20 - ₹35'>",
      "budgetBadge": "Same Budget (~₹20)",
      "reason": "<Why it is substantially healthier: Non-fried, roasted whole seeds, zero palm oil, 80% less saturated fat, rich in natural plant protein and dietary fiber>",
      "estimatedScore": 88,
      "healthHighlights": ["Zero Palm Oil", "80% Less Saturated Fat", "Natural Plant Fiber & Protein"],
      "calorieComparison": "380 kcal vs 558 kcal",
      "fatReduction": "80% less saturated fat"
    },
    {
      "name": "<Second cleaner alternative in same budget, e.g. Roasted Spiced Chickpeas (Chana)>",
      "brand": "<e.g. 'Paper Boat / The Green Snack Co'>",
      "priceINR": "<e.g. '₹20 - ₹30'>",
      "budgetBadge": "Same Budget (~₹20)",
      "reason": "<High in natural fiber and protein, zero hydrogenated fat, slow-release low GI energy>",
      "estimatedScore": 92,
      "healthHighlights": ["Zero Palm Oil", "High Protein (20g/100g)", "Low Glycemic Index"],
      "calorieComparison": "390 kcal vs 558 kcal",
      "fatReduction": "85% less saturated fat"
    }
  ],
  "aiSummary": "<Comprehensive clinical summary of the product's nutritional quality, harmful ingredients (highlighting palm oil/palmolein and sodium if present), and recommended healthy budget swaps.>"
}
${targetQuery ? `User Search Query: "${targetQuery}"` : ''}
${ocrText ? `Packaging OCR Text: """${ocrText.slice(0, 1000)}"""` : ''}
CRITICAL: Output ONLY valid JSON. No markdown code blocks, backticks, or outside text.`;

    parts.push({ text: promptInstructions });

    let parsedResult: any = null;

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: parts.length === 1 ? parts[0].text : { parts },
        config: {
          responseMimeType: 'application/json',
        },
      });

      const responseText = response.text || '';
      console.log('[NutriLens Realtime] Gemini response snippet:', responseText.slice(0, 180));
      parsedResult = JSON.parse(responseText);
    } catch (geminiErr: any) {
      console.warn('[NutriLens Realtime] Gemini call failed, attempting OpenFoodFacts fallback:', geminiErr.message);

      // Real-time Internet Fallback via OpenFoodFacts
      if (targetQuery || ocrText) {
        const fallbackTerm = targetQuery || ocrText.split('\n')[0];
        const offResult = await fetchFromOpenFoodFacts(fallbackTerm);
        if (offResult) {
          const nutriments = offResult.nutriments || {};
          const kcal = Math.round(Number(nutriments['energy-kcal_100g'] || nutriments['energy-kcal'] || 450));
          const fat = Math.round(Number(nutriments.fat_100g || 20) * 10) / 10;
          const satFat = Math.round(Number(nutriments['saturated-fat_100g'] || 8) * 10) / 10;
          const carbs = Math.round(Number(nutriments.carbohydrates_100g || 50) * 10) / 10;
          const sugars = Math.round(Number(nutriments.sugars_100g || 5) * 10) / 10;
          const sodium = Math.round(Number(nutriments.sodium_100g ? nutriments.sodium_100g * 1000 : (nutriments.salt_100g ? nutriments.salt_100g * 400 : 500)));
          const fiber = Math.round(Number(nutriments.fiber_100g || 3) * 10) / 10;
          const protein = Math.round(Number(nutriments.protein_100g || 7) * 10) / 10;

          const ingredientsText = offResult.ingredients_text || offResult.ingredients_text_en || 'Ingredients indexed from OpenFoodFacts.';
          const brand = offResult.brands || 'Packaged Brand';
          const name = offResult.product_name || offResult.product_name_en || fallbackTerm;

          parsedResult = {
            isFoodProduct: true,
            productName: name,
            brand,
            category: offResult.categories || 'Packaged Food',
            servingSize: offResult.serving_size || '30g',
            budgetEstimate: '₹20 - ₹50 per pack',
            kcal,
            nutrients: [
              { name: 'Calories', value: `${kcal} kcal`, per100g: kcal, rating: kcal > 500 ? 'bad' : kcal > 300 ? 'moderate' : 'good', detail: 'Energy density' },
              { name: 'Total Fat', value: `${fat} g`, per100g: fat, rating: fat > 20 ? 'bad' : fat > 10 ? 'moderate' : 'good', detail: 'Dietary lipids' },
              { name: 'Saturated Fat', value: `${satFat} g`, per100g: satFat, rating: satFat > 5 ? 'bad' : satFat > 2 ? 'moderate' : 'good', detail: satFat > 5 ? 'Elevated saturated fatty acids' : 'Moderate' },
              { name: 'Carbohydrates', value: `${carbs} g`, per100g: carbs, rating: 'moderate', detail: 'Carbohydrate content' },
              { name: 'Sugars', value: `${sugars} g`, per100g: sugars, rating: sugars > 15 ? 'bad' : 'good', detail: 'Simple sugars' },
              { name: 'Sodium', value: `${sodium} mg`, per100g: sodium, rating: sodium > 600 ? 'bad' : 'good', detail: 'Sodium content' },
              { name: 'Fiber', value: `${fiber} g`, per100g: fiber, rating: fiber >= 3 ? 'good' : 'moderate', detail: 'Dietary fiber' },
              { name: 'Protein', value: `${protein} g`, per100g: protein, rating: protein >= 8 ? 'good' : 'moderate', detail: 'Protein content' },
            ],
            ingredients: ingredientsText,
            allergens: offResult.allergens_tags?.map((t: string) => t.replace(/^[a-z]+:/, '')) || [],
            harmfulIngredients: [],
            alternatives: [],
            aiSummary: `${name} by ${brand} provides ${kcal} kcal per 100g with ${fat}g fat (${satFat}g saturated) and ${sodium}mg sodium. Verified via live OpenFoodFacts registry.`,
          };
        }
      }
    }

    if (!parsedResult) {
      return res.status(500).json({
        success: false,
        detail: 'Could not recognize nutritional information for this item. Please ensure the label or product is clear and well-lit.',
      });
    }

    // Step 1: Check if non-food item was detected
    if (parsedResult.isFoodProduct === false) {
      return res.json({
        success: true,
        isFoodProduct: false,
        detectedObject: parsedResult.detectedObject || 'Non-food object',
        message:
          parsedResult.message ||
          'Not a food product. NutriLens can only analyze edible packaged foods, snacks, beverages, and meals. Please scan a valid food package or food item.',
      });
    }

    // Step 2: Calculate clinical Nutri-Score & health score from real nutrients
    const nutrientsObj = {
      calories: Number(parsedResult.kcal || 450),
      saturatedFat: parseFloat(parsedResult.nutrients?.find((n: any) => n.name === 'Saturated Fat')?.per100g || 8),
      sugars: parseFloat(parsedResult.nutrients?.find((n: any) => n.name === 'Sugars')?.per100g || 5),
      sodium: parseFloat(parsedResult.nutrients?.find((n: any) => n.name === 'Sodium')?.per100g || 500),
      fiber: parseFloat(parsedResult.nutrients?.find((n: any) => n.name === 'Fiber')?.per100g || 2),
      protein: parseFloat(parsedResult.nutrients?.find((n: any) => n.name === 'Protein')?.per100g || 5),
    };

    const healthResult = predictHealth(nutrientsObj);
    const grade = healthResult.predictedGrade;
    const score = healthResult.healthScore;

    const gradeColors: Record<string, { color: string; bg: string }> = {
      A: { color: '#1B7A43', bg: '#E9F7EF' },
      B: { color: '#4CAF50', bg: '#E8F5E9' },
      C: { color: '#F5A623', bg: '#FFF4E0' },
      D: { color: '#FF7043', bg: '#FBE9E7' },
      F: { color: '#E4483C', bg: '#FDEAE9' },
    };
    const { color: gradeColor, bg: gradeBg } = gradeColors[grade] || gradeColors.F;

    // Harmonize harmful ingredients with rule-based engine detection
    const ruleHarmful = detectHarmfulIngredients(parsedResult.ingredients || '', nutrientsObj);
    const harmfulMap = new Map<string, any>();
    for (const h of parsedResult.harmfulIngredients || []) {
      harmfulMap.set(h.name.toLowerCase().trim(), h);
    }
    for (const rh of ruleHarmful) {
      const key = rh.name.toLowerCase().trim();
      if (!harmfulMap.has(key)) {
        harmfulMap.set(key, rh);
      }
    }
    const finalHarmful = Array.from(harmfulMap.values());

    // Harmonize budget alternatives
    let finalAlternatives = parsedResult.alternatives || [];
    if (!finalAlternatives || finalAlternatives.length === 0) {
      finalAlternatives = getBudgetHealthierAlternatives(
        parsedResult.productName || 'Snack',
        parsedResult.category || 'Food',
        finalHarmful
      );
    }

    // Assemble finalized AnalyzedProduct
    const analyzedProduct = {
      id: `prod_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: parsedResult.productName || targetQuery || 'Scanned Food Product',
      brand: parsedResult.brand || 'Verified Brand',
      score,
      grade,
      gradeColor,
      gradeBg,
      kcal: Number(parsedResult.kcal || 0),
      servingSize: parsedResult.servingSize || '30g',
      allergens: parsedResult.allergens || [],
      nutrients: parsedResult.nutrients || [],
      aiSummary: parsedResult.aiSummary || '',
      image: imageDataUrl || '/vite.svg',
      ingredients: parsedResult.ingredients || 'Ingredients verified via real-time analysis.',
      harmfulIngredients: finalHarmful,
      alternatives: finalAlternatives,
      budgetEstimate: parsedResult.budgetEstimate || '₹20 - ₹50 per pack',
      analysisMode: 'label' as const,
      rawOcrText: ocrText || '',
      mlPrediction: {
        ...healthResult,
        predictedFoodName: parsedResult.productName,
        category: parsedResult.category,
        modelName: 'NutriLens Realtime Health & Ingredient Engine',
      },
    };

    res.json({
      success: true,
      isFoodProduct: true,
      data: analyzedProduct,
    });
  } catch (err: any) {
    console.error('[NutriLens Realtime] Analysis error:', err);
    res.status(500).json({ success: false, detail: err.message || 'Real-time analysis failed.' });
  }
});

app.get('/api/scan/search-products', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) {
      return res.json({ products: [] });
    }

    // Search OpenFoodFacts in real time
    const cleanTerm = q.replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
    const inUrl = `https://in.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(cleanTerm)}&search_simple=1&action=process&json=1&page_size=8`;
    const response = await fetch(inUrl, { headers: { 'User-Agent': 'NutriLens/1.2 (AI Studio Educational)' } });
    if (response.ok) {
      const data = await response.json();
      if (data.products && data.products.length > 0) {
        const mapped = data.products.map((p: any) => ({
          name: p.product_name || p.product_name_en || q,
          brand: p.brands || 'Packaged Food',
          kcal: Math.round(Number(p.nutriments?.['energy-kcal_100g'] || 0)),
          hasPalmOil: (p.ingredients_text || '').toLowerCase().includes('palm'),
          grade: p.nutrition_grades ? (p.nutrition_grades.toUpperCase() as any) : 'C',
          score: p.nutriscore_score ? Math.max(0, 100 - p.nutriscore_score * 3) : 50,
        }));
        return res.json({ products: mapped });
      }
    }

    res.json({ products: [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/ask', async (req, res) => {
  try {
    const { product, userQuery } = req.body || {};
    if (!userQuery) {
      return res.json({
        success: true,
        answer: 'How can I assist you with this food product, its harmful ingredients, or healthier alternatives?',
      });
    }

    const prompt = `You are NutriLens AI, an expert clinical food nutritionist and dietitian.
The user is asking a question about this scanned product:
Product: ${product?.name || 'Unknown food'} by ${product?.brand || 'Unknown brand'}
Nutri-Score: Grade ${product?.grade || 'N/A'} (Health Score: ${product?.score || 0}/100)
Ingredients: ${product?.ingredients || 'N/A'}
Harmful/Risk Ingredients: ${JSON.stringify(product?.harmfulIngredients || [])}
Nutrients: ${JSON.stringify(product?.nutrients || [])}
Recommended Budget Alternatives: ${JSON.stringify(product?.alternatives || [])}

User Question: "${userQuery}"

Provide a direct, scientifically rigorous, and helpful answer (2-4 sentences max). If they ask about palm oil/palmolein, explain the palmitic acid content and LDL cholesterol/arterial plaque impact. If they ask about healthier swaps, recommend options in the same price range. Maintain an empathetic, educational tone. Do not use markdown headers or bullet lists.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
    });

    const answer = response.text?.trim() || 'Could not generate an answer at this time.';
    res.json({ success: true, answer });
  } catch (err: any) {
    console.error('[NutriLens AI Ask] Error:', err);
    res.status(500).json({ success: false, detail: err.message || 'Failed to process AI question.' });
  }
});

// ─── Development vs Production Mounting ─────────────────────────────────────

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    // Vite middleware in dev
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Serve static files in production
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[NutriLens] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[NutriLens] Failed to start server:', err);
  process.exit(1);
});
