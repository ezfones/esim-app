import { getCookie, unseal, storefrontGraphql } from "../../../lib/storefront-auth";

function pick(obj, keys) {
  for (const k of keys) if (obj?.[k]) return obj[k];
  return null;
}

export default async function handler(req, res) {
  try {
    const packed = getCookie(req, "sf_sess");
    const sess = unseal(packed);
    if (!sess?.accessToken) return res.status(401).json({ ok: false, error: "Not logged in" });

    const query = `
      query EsimOrders($token: String!, $first: Int!) {
        customer(customerAccessToken: $token) {
          orders(first: $first, sortKey: PROCESSED_AT, reverse: true) {
            nodes {
              id
              name
              processedAt
              metafields(first: 50) {
                edges {
                  node { namespace key value }
                }
              }
            }
          }
        }
      }
    `;

    const data = await storefrontGraphql(query, { token: sess.accessToken, first: 50 });
    const orders = data?.customer?.orders?.nodes || [];

    const esims = [];
    for (const o of orders) {
      const mfs = (o.metafields?.edges || []).map((e) => e.node);
      const mf = {};
      for (const m of mfs) {
        mf[`${m.namespace}.${m.key}`] = m.value;
      }

      // only include orders that have at least one key eSIM field
      const matchingId = pick(mf, ["esim.matching_id", "esim.matchingId"]);
      const lpa = pick(mf, ["esim.ipa", "esim.lpa", "esim.lpa_string"]);
      const orderReference = pick(mf, ["esim.order_reference", "esim.reference"]);
      const bundle = pick(mf, ["esim.bundle"]);
      const qrUrl = pick(mf, ["esim.qr_url", "esim.qr_png_url"]);
      const iosInstallUrl = pick(mf, ["esim.ios_install_url", "esim.ios_universal_link"]);

      const iccid = pick(mf, ["esim.iccid", "esim.ICCID"]);
      const smdpAddress = pick(mf, ["esim.smdp_address", "esim.smdp", "esim.SMDP Address"]);

      if (!matchingId && !lpa && !qrUrl && !iosInstallUrl && !iccid) continue;

      esims.push({
        orderId: o.id,
        orderName: o.name,
        processedAt: o.processedAt,
        bundle,
        orderReference,
        matchingId,
        lpa,
        qrUrl,
        iosInstallUrl,
        iccid,
        smdpAddress,
      });
    }

    return res.status(200).json({ ok: true, esims });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "error" });
  }
}
