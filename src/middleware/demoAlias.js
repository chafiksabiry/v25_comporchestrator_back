import mongoose from 'mongoose';

/**
 * Alias de démonstration : la valeur littérale `demo_company_id` (corps, requête ou chemin) est réécrite en l'identifiant d'une société RÉELLE codé en
 * dur. Sur toute route non protégée par propriété, cela donne accès aux données de cette société à quiconque connaît l'alias. Aucun appelant connu
 * (fronts et dash_calls lus : aucun n'envoie `demo_company_id` ; le front a seulement un repli sur le même identifiant quand le cookie companyId manque).
 * DÉCISION DU PROPRIÉTAIRE : l'alias est DÉSACTIVÉ par défaut (l'alias donne 400 « Invalid companyId format », jamais réécrit). Réactivable uniquement avec
 * `DEMO_COMPANY_ID_ENABLED=true` (démo explicite).
 */
export const DEMO_ALIAS = 'demo_company_id';
export const DEMO_COMPANY_ID = '6a0bfd35d605ccca8b51e13b';
export const demoAliasEnabled = (env = process.env) => String(env.DEMO_COMPANY_ID_ENABLED || '').trim().toLowerCase() === 'true';

/** Réécriture de l'alias dans le corps et la requête (inactive si désactivée). */
export function demoBodyQueryAlias(env = process.env) {
  return (req, res, next) => {
    if (demoAliasEnabled(env)) {
      if (req.body && req.body.companyId === DEMO_ALIAS) req.body.companyId = DEMO_COMPANY_ID;
      if (req.query && req.query.companyId === DEMO_ALIAS) req.query.companyId = DEMO_COMPANY_ID;
    }
    next();
  };
}

/** Validation d'un paramètre de chemin (`companyId`, `agentId`) : alias de démonstration (si actif) puis format ObjectId. */
export function idParam(name, env = process.env) {
  return (req, res, next, value) => {
    if (value === DEMO_ALIAS && demoAliasEnabled(env)) {
      req.params[name] = DEMO_COMPANY_ID;
      return next();
    }
    if (!mongoose.Types.ObjectId.isValid(value)) return res.status(400).json({ error: `Invalid ${name} format` });
    return next();
  };
}
