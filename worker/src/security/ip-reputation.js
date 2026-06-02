/**
 * ip-reputation.js — block known datacenter / VPN CIDR ranges.
 *
 * WHY THIS MATTERS:
 * Real ticket buyers use residential ISPs.  Bots almost always run in cloud
 * datacenters (AWS, GCP, Azure, DigitalOcean) because those are cheap and
 * programmable.  Blocking datacenter CIDRs is one of the first defenses real
 * ticketing platforms apply.
 *
 * This list is intentionally incomplete — the full production lists have
 * millions of CIDRs.  The educational version covers the most common ranges
 * so students can learn to detect and route around them.
 *
 * CHALLENGER HINT:
 * Residential proxies (e.g. Bright Data, Oxylabs) route traffic through real
 * home ISP IPs.  They're expensive but bypass IP reputation checks.  The
 * platform's behavioral and fingerprinting layers still apply, so combine both
 * evasion techniques.
 */

// Major cloud/datacenter CIDR blocks (IPv4 only for simplicity)
const DATACENTER_CIDRS = [
  // AWS
  "3.0.0.0/8", "13.32.0.0/15", "18.0.0.0/8", "34.192.0.0/10", "52.0.0.0/8",
  "54.0.0.0/8",
  // GCP
  "34.0.0.0/9", "35.184.0.0/13", "104.154.0.0/15",
  // Azure
  "13.64.0.0/11", "20.0.0.0/8", "40.64.0.0/10",
  // DigitalOcean
  "104.16.0.0/12", "159.65.0.0/16", "167.99.0.0/16",
  // Linode / Akamai
  "45.33.0.0/17", "45.56.0.0/21", "45.79.0.0/17",
  // OVH
  "51.68.0.0/16", "51.75.0.0/16", "54.36.0.0/14",
  // Cloudflare (meta — would block the Worker itself in prod, included for study)
  // "104.16.0.0/13",
];

const parsedCidrs = DATACENTER_CIDRS.map(parseCidr).filter(Boolean);

export function isDatacenterIP(ip) {
  const ipNum = ipToNumber(ip);
  if (ipNum === null) return false;
  return parsedCidrs.some(({ network, mask }) => (ipNum & mask) === network);
}

function ipToNumber(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return null;
  return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
}

function parseCidr(cidr) {
  const [addr, prefix] = cidr.split("/");
  const prefixLen = parseInt(prefix, 10);
  const mask = prefixLen === 0 ? 0 : ~((1 << (32 - prefixLen)) - 1) >>> 0;
  const network = (ipToNumber(addr) & mask) >>> 0;
  return { network, mask };
}
