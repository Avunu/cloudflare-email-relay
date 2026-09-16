// The `wrangler dev` entry: the relay bound to dev/tenants.json, whose one tenant points at a
// local ERP through the TENANT_DEV secret in .dev.vars. Production entries live in the fleet
// repository and look exactly like this file.
import { createRelay } from "../src/index";
import tenants from "./tenants.json";

const relay = createRelay({ tenants });

export default relay.handler;
export const { InboxQueue } = relay;
