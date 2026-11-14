/**
 * zod schemas for API inputs. They mirror lib/types.ts (the contract) and add
 * bounds so a request can't smuggle huge payloads into scoring or the LLM.
 * Optional arrays/flags get safe defaults so slightly older clients still validate.
 */
import { z } from "zod";
import { CATEGORIES } from "./types";

export const CategorySchema = z.enum(CATEGORIES);

const money = (max = 1_000_000) => z.number().min(0).max(max);
const shortText = (max: number) => z.string().trim().max(max);

export const PresaleSchema = z.object({
  name: shortText(200),
  start: shortText(40),
  end: shortText(40).optional(),
});

export const EventSchema = z.object({
  id: z.string().trim().min(1).max(200),
  source: z.enum(["ticketmaster", "curated", "sample"]),
  name: z.string().trim().min(1).max(300),
  category: CategorySchema,
  genre: shortText(100).optional(),
  subGenre: shortText(100).optional(),
  date: shortText(40).optional(),
  time: shortText(20).optional(),
  venue: shortText(200).optional(),
  city: shortText(100),
  state: shortText(40).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  distanceMiles: z.number().min(0).max(30_000).optional(),
  priceMin: money().optional(),
  priceMax: money().optional(),
  currency: shortText(10).optional(),
  priceNote: shortText(300).optional(),
  onSaleStart: shortText(40).optional(),
  presales: z.array(PresaleSchema).max(20).optional(),
  url: shortText(2_000),
  image: shortText(2_000).optional(),
  attribution: shortText(200).optional(),
  tags: z.array(shortText(100)).max(60).default([]),
});

export const ProfileSchema = z.object({
  version: z.literal(1).default(1),
  interests: z.array(CategorySchema).max(CATEGORIES.length).default([]),
  favourites: z.array(shortText(80)).max(30).default([]),
  city: shortText(100).default(""),
  stateCode: shortText(10).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  radiusMiles: z.number().min(0).max(5_000).default(30),
  monthlyFunBudget: money().default(0),
  hotelPerNight: money(100_000).default(0),
  travelPerTrip: money(100_000).default(0),
  vacationDaysLeft: z.number().min(0).max(366).default(0),
  preferredMonths: z.array(z.number().int().min(1).max(12)).max(12).default([]),
  liked: z.array(shortText(200)).max(2_000).default([]),
  skipped: z.array(shortText(200)).max(2_000).default([]),
  likedTags: z.array(shortText(100)).max(1_000).default([]),
  isSample: z.boolean().default(false),
  createdAt: shortText(40).default(""),
});

export const CostOverridesSchema = z.object({
  tickets: z.number().min(0).max(50).optional(),
  ticketPrice: money(100_000).optional(),
  feesPct: z.number().min(0).max(1).optional(),
  travel: money(100_000).optional(),
  hotelNights: z.number().min(0).max(60).optional(),
  hotelPerNight: money(100_000).optional(),
  bufferPct: z.number().min(0).max(1).optional(),
});

export const CostLineSchema = z.object({
  key: z.enum(["ticket", "fees", "travel", "hotel", "buffer"]),
  label: shortText(200),
  amount: money(10_000_000),
  estimate: z.boolean(),
  note: shortText(300).optional(),
});

export const PlanResultSchema = z.object({
  lines: z.array(CostLineSchema).max(10),
  total: money(10_000_000),
  deadline: shortText(40),
  deadlineKind: z.enum(["on-sale", "event", "none"]),
  weeks: z.number().min(0).max(5_000),
  weekly: money(10_000_000),
  envelopeBalance: z.number().min(-10_000_000).max(10_000_000).default(0),
});

export const RecommendRequestSchema = z.object({
  profile: ProfileSchema,
  events: z.array(EventSchema).max(300),
  recentGoalCategories: z.array(CategorySchema).max(3).optional(),
});

export const PlanRequestSchema = z.object({
  event: EventSchema,
  profile: ProfileSchema,
  envelopeBalance: z.number().min(-10_000_000).max(10_000_000).default(0),
  overrides: CostOverridesSchema.optional(),
});

export const RoadmapRequestSchema = z.object({
  event: EventSchema,
  profile: ProfileSchema,
  plan: PlanResultSchema,
});

export const InsightsRequestSchema = z.object({
  csv: z.string().optional(),
  sample: z.boolean().optional(),
  goals: z
    .array(
      z.object({
        envelopeId: shortText(100).optional(),
        eventName: shortText(300),
        target: money(10_000_000),
      }),
    )
    .max(50)
    .default([]),
});

export const AlertSubscribeSchema = z.object({
  channel: z.enum(["email", "telegram"]),
  address: shortText(254).optional(),
  interests: z.array(CategorySchema).max(CATEGORIES.length).default([]),
  favourites: z.array(shortText(80)).max(30).default([]),
  city: shortText(100).default(""),
  stateCode: shortText(10).optional(),
});

export const CheckoutRequestSchema = z.object({
  plan: z.enum(["monthly", "yearly"]),
});

export const LogRequestSchema = z.object({
  anonId: z.string().trim().min(1).max(100).regex(/^[\w-]+$/),
  eventId: z.string().trim().min(1).max(200),
  action: z.enum(["open", "like", "skip", "save"]),
});
