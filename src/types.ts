export type PricingRuleConfig = {
  basePriceBridal: number;
  basePriceEngagement: number;
  basePriceReception: number;
  basePriceParty: number;
  basePriceShoot: number;
  basePriceOther: number;
  multiplierJan: number;
  multiplierFeb: number;
  multiplierMar: number;
  multiplierApr: number;
  multiplierMay: number;
  multiplierJun: number;
  multiplierJul: number;
  multiplierAug: number;
  multiplierSep: number;
  multiplierOct: number;
  multiplierNov: number;
  multiplierDec: number;
  holdExpiryHours: number;
  scarcityThresholdSoft: number;
  scarcityThresholdHard: number;
  advancePercentage: number;
};

export type WorkspaceConfig = PricingRuleConfig & {
  businessName: string;
  ownerName: string;
  ownerEmail: string;
  ownerWhatsApp: string;
  city: string;
  instagramHandle: string;
  aiLanguage: string;
  aiSignOff: string;
  travelWithinCity: number;
  travelNearbyCity: number;
  travelOutstation: number;
  travelOutstationThresholdKm: number;
  profileLowMultiplier: number;
  profileMidMultiplier: number;
  profileHighMultiplier: number;
  profileHighMinFollowers: number;
  upiId: string;
  qrImageUrl: string;
  paymentTerms: string;
  googleReviewLink: string;
  contractTemplateUrl: string;
  confirmedCalendarId: string;
  tentativeCalendarId: string;
  bookingPageEnabled: string;
  bookingLeadTimeDays: number;
  bookingMaxAdvanceDays: number;
  bookingWeeklyOffDays: string;
  bookingBlockedDates: string;
  bookingMaxPerDay: number;
  bookingConfirmTemplate: string;
  bookingConfirmTemplateLang: string;
  approvalTemplate: string;
  approvalTemplateLang: string;
  notifyTeamOnBooking: string;
  teamNotifyTemplate: string;
  teamNotifyTemplateLang: string;
  quoteTemplate: string;
  quoteTemplateLang: string;
  invoiceTemplate: string;
  invoiceTemplateLang: string;
  contractTemplate: string;
  contractTemplateLang: string;
  collectionTemplate: string;
  collectionTemplateLang: string;
  reminderTemplate: string;
  reminderTemplateLang: string;
  reminderDaysBefore: string;
  serviceBridalDesc: string;
  serviceEngagementDesc: string;
  serviceReceptionDesc: string;
  servicePartyDesc: string;
  serviceShootDesc: string;
  serviceOtherDesc: string;
  serviceBridalAddons: string;
  serviceEngagementAddons: string;
  serviceReceptionAddons: string;
  servicePartyAddons: string;
  serviceShootAddons: string;
  serviceOtherAddons: string;
  bookingTimeSlots: string;
  bookingWaitlistEnabled: string;
  portfolioImages: string;
  aboutText: string;
  reviewRequestDaysAfter: string;
  reviewTemplate: string;
  reviewTemplateLang: string;
  documentTemplate: string;
  quoteIntro: string;
  cancellationPolicy: string;
  contractTerms: string;
};

export type WalletLedgerEntry = {
  id: string;
  type: "credit" | "debit";
  credits: number; // positive number of credits moved
  reason: string;
  ref?: string; // razorpay payment/event id or usage ref (idempotency key)
  amountInr?: number; // rupees paid, for top-ups
  balanceAfter: number;
  createdAt: string;
};

export type Wallet = {
  balanceCredits: number;
  ledger: WalletLedgerEntry[];
  // Idempotency keys already applied, so a webhook + checkout callback for the
  // same payment can never double-credit.
  processedRefs: string[];
};

export type StoredGoogleTokens = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number | null;
};

export type MetaChannel = "instagram" | "whatsapp";

export type MetaChannelConnection = {
  channel: MetaChannel;
  status: "connected" | "disconnected" | "pending";
  connectedAt?: string;
  disconnectedAt?: string;
  metaUserId?: string;
  metaUserName?: string;
  accessToken?: string;
  pageAccessToken?: string;
  tokenExpiresAt?: number | null;
  scopes?: string[];
  pageId?: string;
  pageName?: string;
  instagramBusinessAccountId?: string;
  instagramUsername?: string;
  wabaId?: string;
  phoneNumberId?: string;
  businessAccountName?: string;
  dataIsolationKey: string;
};

export type WorkspaceRecord = {
  workspaceId: string;
  email: string;
  name: string;
  spreadsheetId: string;
  spreadsheetUrl: string;
  spreadsheetName: string;
  confirmedCalendarId: string;
  tentativeCalendarId: string;
  tentativeCalendarName: string;
  createdAt: string;
  updatedAt: string;
  sheetProtected?: boolean;
  googleTokens?: StoredGoogleTokens;
  metaConnections?: Partial<Record<MetaChannel, MetaChannelConnection>>;
  wallet?: Wallet;
  config: WorkspaceConfig;
};

export type GoogleProfile = {
  email: string;
  name: string;
  picture?: string;
};
