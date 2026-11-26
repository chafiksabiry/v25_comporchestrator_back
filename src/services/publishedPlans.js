/**
 * Catalogue d'abonnements PUBLIÉ : la liste exacte que renvoie GET /api/subscriptions/plans, réutilisable ailleurs
 * (assistant WhatsApp) pour que personne ne lise directement la base locale des forfaits.
 *
 * Règles (inchangées, déplacées depuis subscriptionController.getPlans) :
 *  - seuls les forfaits de la base qui ont un `stripePriceId` sont candidats ;
 *  - le prix doit être ACTIF dans Stripe (directement, ou retrouvé par `resolveSubscriptionPriceId`), sinon le forfait est écarté :
 *    un ancien forfait dont le prix est archivé n'est jamais publié, même s'il reste en base avec son ancien prix ;
 *  - un même prix Stripe n'est publié qu'une fois ;
 *  - prix, devise, nom, description, limites (minutes, jetons, numéros inclus) viennent du prix et du produit Stripe, jamais de la base ;
 *  - Marketplace (TAAS) et Call Centre (CLOUD / NOMAD, `harx_product=callcenter`) sont deux catalogues distincts.
 */
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import { stripeService } from './stripeService.js';
import { aiAgentFromMetadata } from './planLimits.js';
import { callcenterTierFromMetadata, isCallcenterMetadata } from './callcenterTier.js';
import { currencyForCountry, normalizeCurrency, pickCurrency, priceAmounts } from './currency.js';

function metadataObject(metadata) {
  if (!metadata) return {};
  if (metadata instanceof Map) return Object.fromEntries(metadata.entries());
  if (typeof metadata === 'object') return { ...metadata };
  return {};
}

export function isCallcenterProduct(product) {
  return isCallcenterMetadata(product?.metadata);
}

/** Devise demandée : `currency` (eur|usd|gbp) prime, sinon devise du pays du souscripteur (GB -> gbp, US -> usd, sinon eur), sinon ''. */
export function requestedCurrencyFrom({ currency, country } = {}) {
  if (currency) return normalizeCurrency(currency, '');
  if (country) return currencyForCountry(country);
  return '';
}

/** Inscrit en base les prix Stripe actifs et récurrents des produits Call Centre qui n'y sont pas encore. */
async function registerCallcenterPlans(stripePrices, Plan, logger) {
  for (const price of stripePrices) {
    try {
      const product = price.product;
      if (!isCallcenterProduct(product) || !price.recurring || price.unit_amount == null) continue;
      if (await Plan.exists({ stripePriceId: price.id })) continue;
      await Plan.create({
        name: product.name,
        price: Number((price.unit_amount / 100).toFixed(2)),
        currency: price.currency || 'eur',
        stripePriceId: price.id,
        description: product.description || '',
        // Les métadonnées du produit (palier, limites) sont lues par les autres services dès le premier achat : la
        // limite de lignes et de sièges de Nomad Solo ne doit pas attendre la première lecture de l'abonnement.
        metadata: Object.fromEntries(
          Object.entries(metadataObject(product.metadata)).map(([key, value]) => [key, String(value ?? '')])
        ),
      });
    } catch (err) {
      logger.warn('[subscriptions/plans] Call Centre plan registration failed:', err.message);
    }
  }
}

/**
 * @param {object} [options]
 * @param {'callcenter'|'marketplace'|'all'} [options.product='marketplace'] catalogue à lire (`all` : les deux, chacun marqué par `metadata.harx_product`).
 * @param {string} [options.currency] devise demandée (eur|usd|gbp) : appliquée quand le prix Stripe la propose.
 * @param {string} [options.country] pays du souscripteur (ISO 3166-1 alpha-2), utilisé si `currency` est absent.
 * @param {object} [deps] dépendances substituables (tests) : `stripe` (stripeService), `Plan` (modèle SubscriptionPlan), `logger`.
 * @returns {Promise<{ plans: object[], stripeAvailable: boolean, requestedCurrency: string }>}
 *   `stripeAvailable` vaut false quand Stripe n'est pas configuré ou que la lecture du catalogue Stripe a échoué :
 *   les prix ne peuvent alors pas être confirmés (la liste ne contient que ce qui a pu être relu un par un, souvent rien).
 */
export async function listPublishedPlans(options = {}, deps = {}) {
  const stripe = deps.stripe || stripeService;
  const Plan = deps.Plan || SubscriptionPlan;
  const logger = deps.logger || console;
  const product = options.product || 'marketplace';
  const requestedCurrency = requestedCurrencyFrom(options);
  const configured = stripe.isConfigured();

  // 1. Métadonnées Stripe (prix actuel, nom produit) pour les plans connus.
  let stripePrices = [];
  let stripeListOk = configured;
  try {
    stripePrices = await stripe.getPublicPlans();
  } catch (err) {
    stripeListOk = false;
    logger.warn('[subscriptions/plans] Stripe lookup failed, using DB only:', err.message);
  }

  // 2. La DB est la source de vérité : seuls les plans listés ici sont publiés.
  //    Les forfaits Call Centre y sont inscrits dès qu'un prix Stripe actif porte harx_product=callcenter.
  await registerCallcenterPlans(stripePrices, Plan, logger);
  // Forfaits locaux sans prix Stripe (NOMAD Traveler, paiement unique : `harx_…`) : jamais dans le catalogue des abonnements.
  const dbPlans = (await Plan.find({ stripePriceId: { $exists: true, $ne: '' } })).filter((p) => !String(p.stripePriceId || '').startsWith('harx_'));

  const seen = new Set();
  const plans = (
    await Promise.all(
      dbPlans.map(async (dbPlan) => {
        if (!dbPlan.stripePriceId) return null;

        let effectivePriceId = dbPlan.stripePriceId;
        if (stripe.isConfigured()) {
          try {
            effectivePriceId = await stripe.resolveSubscriptionPriceId({
              priceId: dbPlan.stripePriceId,
              planName: dbPlan.name,
            });
            if (effectivePriceId !== dbPlan.stripePriceId) {
              await Plan.findByIdAndUpdate(dbPlan._id, {
                stripePriceId: effectivePriceId,
              });
            }
          } catch (err) {
            logger.warn(`[subscriptions/plans] Skip ${dbPlan.name}: ${err.message}`);
            return null;
          }
        }

        if (seen.has(effectivePriceId)) return null;
        seen.add(effectivePriceId);

        let stripePrice = stripePrices.find((p) => p.id === effectivePriceId);
        if (!stripePrice && stripe.isConfigured()) {
          try {
            stripePrice = await stripe.retrievePriceWithProduct(effectivePriceId);
          } catch (err) {
            logger.warn(`[subscriptions/plans] retrieve ${effectivePriceId} failed:`, err.message);
          }
        }
        // Stripe Catalog only — skip plans that have no live price/product.
        if (!stripePrice || !stripePrice.product || typeof stripePrice.product !== 'object') {
          logger.warn(`[subscriptions/plans] Skip ${dbPlan.name}: no active Stripe price/product for ${effectivePriceId}`);
          return null;
        }
        const stripeProduct = stripePrice.product;
        // Marketplace et Call Centre ont chacun leur catalogue : on ne mélange pas les forfaits.
        if (product !== 'all' && isCallcenterProduct(stripeProduct) !== (product === 'callcenter')) return null;
        const marketingFeatures = stripeService.extractStripeProductFeatures(stripeProduct);
        const stripeLimits = stripeService.extractStripeProductLimits(stripeProduct);
        const displayFeatures = stripeService.buildStripePlanDisplayFeatures(stripeProduct);
        const amounts = priceAmounts(stripePrice);
        const baseCurrency = stripePrice.currency || 'eur';
        const shownCurrency = pickCurrency(requestedCurrency, amounts, baseCurrency);
        const shownCents = amounts[shownCurrency] ?? stripePrice.unit_amount;

        return {
          _id: dbPlan._id,
          name: stripeProduct.name || dbPlan.name,
          // Keep integer Stripe cents — never round euros for display.
          priceCents: shownCents,
          price: Number((shownCents / 100).toFixed(2)),
          currency: shownCurrency,
          /** Montants (centimes) par devise proposée par le prix Stripe, ex. { eur: 4900, usd: 4900, gbp: 4900 }. */
          prices: amounts,
          currencies: Object.keys(amounts),
          stripePriceId: effectivePriceId,
          description: stripeProduct.description || '',
          features: displayFeatures,
          marketingFeatures,
          metadata: stripeProduct.metadata || {},
          /** Palier canonique (nomad_solo, accueil, full_scope, multi_clients) ; anciennes valeurs converties. */
          callcenterTier: callcenterTierFromMetadata(stripeProduct.metadata),
          /** Formule « Secrétariat avec agent IA » (palier accueil + `ai_agent=true`) : distincte de l'Accueil seul (autre prix, autre ligne). */
          ...(() => { const ai = aiAgentFromMetadata(stripeProduct.metadata); return { aiAgent: ai.aiAgent, aiAgentIncludedMinutes: ai.aiAgentIncludedMinutes, aiAgentOverageCentsTtc: ai.aiAgentOverageCentsTtc }; })(),
          isPopular: Boolean(dbPlan.isPopular),
          maxGigs: stripeLimits.maxGigs,
          maxReps: stripeLimits.maxReps,
          communicationMinutes: stripeLimits.communicationMinutes,
          activeLocalNumbers: stripeLimits.activeLocalNumbers,
          aiToken: stripeLimits.aiToken,
          aiTokensIncluded: stripeLimits.aiTokensIncluded,
        };
      })
    )
  )
    .filter(Boolean)
    .sort((a, b) => a.price - b.price);

  return { plans, stripeAvailable: stripeListOk, requestedCurrency };
}
