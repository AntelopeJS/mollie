import type { Journey } from "@antelopejs/tooling-configs/verify";

import { PRIMARY_KEY, RETURN_URL, answered, call, callsTo, fresh, pick, same, savedMethod, settle, text, thrown, withSession, wire } from "./session.ts";

const customerLifecycle: Journey = {
  title: "a customer is created at Mollie with its email, name and metadata, reads back, and is gone after deletion",
  entryPoint: "`CreateCustomer`, `GetCustomer` and `DeleteCustomer` through core",
  async run(context) {
    await withSession(context, async (session) => {
      const created = await call(session, "CreateCustomer", "CreateCustomer", [{ email: "ada@merchant.invalid", name: "Ada", metadata: { plan: "pro" } }, fresh("key"), null]);
      const id = text(pick(created.value, "id"));
      const held = await wire(session.base, "GET", `/v2/customers/${id}`, PRIMARY_KEY);
      context.expect(created.folder, [
        answered(created),
        same("the answer carries the email, name and metadata", [pick(created.value, "email"), pick(created.value, "name"), pick(created.value, "metadata")], ["ada@merchant.invalid", "Ada", { plan: "pro" }]),
        same("Mollie holds the customer with the same email and name", [held.status, pick(held.json, "email"), pick(held.json, "name")], [200, "ada@merchant.invalid", "Ada"]),
        same("Mollie holds the caller's metadata", pick(held.json, "metadata", "metadata"), { plan: "pro" }),
      ]);
      const read = await call(session, "GetCustomer", "GetCustomer", [id, null]);
      context.expect(read.folder, [
        same("reading it back gives the same customer with its email, name and metadata", [pick(read.value, "id"), pick(read.value, "email"), pick(read.value, "name"), pick(read.value, "metadata")], [id, "ada@merchant.invalid", "Ada", { plan: "pro" }]),
      ]);
      const deleted = await call(session, "DeleteCustomer", "DeleteCustomer", [id, fresh("key"), null]);
      const gone = await call(session, "GetCustomer after deletion", "GetCustomer", [id, null]);
      context.expect(gone.folder, [
        answered(deleted),
        same("a deleted customer is a CustomerNotFoundError", pick(thrown(gone), 0), "CustomerNotFoundError"),
        same("Mollie no longer has it", (await wire(session.base, "GET", `/v2/customers/${id}`, PRIMARY_KEY)).status, 404),
      ]);
    });
  },
};

const savedMethodCharge: Journey = {
  title: "a payment with savePaymentMethod leaves a mandate the customer can be charged on without the payer, and detaching it revokes the mandate",
  entryPoint: "`CreatePayment` with `savePaymentMethod`, `ListPaymentMethods`, an off-session `CreatePayment` and `DetachPaymentMethod` through core",
  async run(context) {
    await withSession(context, async (session) => {
      const saved = await savedMethod(session, "saved card");
      const methods = await call(session, "ListPaymentMethods", "ListPaymentMethods", [saved.customer, null]);
      context.expect(methods.folder, [
        same("the customer has exactly one saved method, a card, named customer:mandate", [pick(methods.value, 0, "type"), pick(methods.value, 0, "customer"), text(pick(methods.value, 0, "id")).startsWith(`${saved.customer}:mdt_`)], ["card", saved.customer, true]),
      ], { critical: true });
      const mandate = text(saved.method.split(":")[1]);
      const mandateAtProvider = await wire(session.base, "GET", `/v2/customers/${saved.customer}/mandates/${mandate}`, PRIMARY_KEY);
      context.expect(methods.folder, [same("Mollie holds that mandate as valid", pick(mandateAtProvider.json, "status"), "valid")]);
      const charged = await call(session, "off-session CreatePayment", "CreatePayment", [
        { amount: { value: 2500, currency: "EUR" }, reference: fresh("renewal"), paymentMethod: saved.method, offSession: true },
        fresh("key"),
        null,
      ]);
      const id = text(pick(charged.value, "id"));
      const sent = callsTo(session, "POST", "/v2/payments").at(-1);
      context.expect(charged.folder, [
        answered(charged),
        same("a charge on a saved method is pending, not decided by the call", pick(charged.value, "status"), "pending"),
        same("Mollie got a recurring payment on that customer and mandate", [pick(sent?.body, "sequenceType"), pick(sent?.body, "customerId"), pick(sent?.body, "mandateId")], ["recurring", saved.customer, mandate]),
      ]);
      settle(session, id, "paid");
      const read = await call(session, "GetPayment", "GetPayment", [id, null]);
      context.expect(read.folder, [same("Mollie settles it and the payment reads succeeded", pick(read.value, "status"), "succeeded")]);
      const stranger = await call(session, "CreateCustomer for another payer", "CreateCustomer", [{ email: "other@merchant.invalid" }, fresh("key"), null]);
      const wrongOwner = await call(session, "charge the method for another customer", "CreatePayment", [
        { amount: { value: 2500, currency: "EUR" }, reference: fresh("renewal"), paymentMethod: saved.method, customer: text(pick(stranger.value, "id")), offSession: true },
        fresh("key"),
        null,
      ]);
      context.expect(wrongOwner.folder, [same("a method belongs to one customer", pick(thrown(wrongOwner), 0), "CustomerNotFoundError")]);
      const noMethod = await call(session, "off-session without a saved method", "CreatePayment", [{ amount: { value: 2500, currency: "EUR" }, reference: fresh("renewal"), offSession: true, returnUrl: RETURN_URL }, fresh("key"), null]);
      context.expect(noMethod.folder, [same("offSession needs a saved method", pick(thrown(noMethod), 0), "PaymentError")]);
      const detached = await call(session, "DetachPaymentMethod", "DetachPaymentMethod", [saved.method, fresh("key"), null]);
      const after = await call(session, "ListPaymentMethods after detaching", "ListPaymentMethods", [saved.customer, null]);
      context.expect(after.folder, [
        answered(detached),
        same("no saved method is left", pick(after.value, "length") ?? (Array.isArray(after.value) ? after.value.length : -1), 0),
        same("Mollie keeps the revoked mandate as invalid", pick((await wire(session.base, "GET", `/v2/customers/${saved.customer}/mandates/${mandate}`, PRIMARY_KEY)).json, "status"), "invalid"),
      ]);
    });
  },
};

export const customerJourneys = {
  "customer-lifecycle": customerLifecycle,
  "saved-method-charge": savedMethodCharge,
};
