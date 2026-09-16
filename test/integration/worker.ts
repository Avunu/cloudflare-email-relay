// The Worker the integration suites run: the relay bound to the fixture tenant table, shaped
// exactly like a fleet entry (see dev/index.ts).
import { createRelay } from "../../src/index";
import { TEST_TENANTS } from "./outbound";

const relay = createRelay({ tenants: TEST_TENANTS });

export default relay.handler;
export const { InboxQueue } = relay;
