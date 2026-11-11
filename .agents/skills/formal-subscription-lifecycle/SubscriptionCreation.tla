------------------------- MODULE SubscriptionCreation -------------------------
(***************************************************************************)
(* CreateSubscription of @antelopejs/mollie for one customer and one       *)
(* idempotency key, with Mollie as the environment. Each Mollie request is *)
(* one atomic step. A request can fail before Mollie applies it, which is  *)
(* also how a crash between two requests looks, or after Mollie applied    *)
(* it with the answer lost. Mollie remembers a POST's idempotency key for  *)
(* an hour, so a key can be forgotten only once every call that was        *)
(* running when Mollie stored it has ended: one call lasts far less than   *)
(* an hour (client.ts:19, a 30 s timeout per request).                     *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Calls,        \* CreateSubscription calls under the one key: concurrent, or a retry at any later time
  Declines,     \* TRUE: Mollie may answer the first charge `failed` in its creating response
  LateFailures  \* TRUE: an open first charge may turn `failed` afterwards

VARIABLES
  subs,     \* the customer's Mollie subscriptions, oldest first; each carries the key as createKey
  charges,  \* the first-period charges, oldest first
  keys,     \* Mollie's idempotency store for the subscription POST and the first-charge POST
  pc,       \* where each call is
  answer,   \* what each call answered
  target,   \* the subscription each call works on, 0 before it has one
  snap,     \* the module's metadata of that subscription as the call's GET read it
  seen,     \* that subscription's Mollie status as the call last read it
  pay       \* the first charge the call holds, with the status it read

vars == <<subs, charges, keys, pc, answer, target, snap, seen, pay>>

Ids == 0..Cardinality(Calls)
Steps == {"idle", "postSub", "get", "earlier", "postCharge",
          "patchFirst", "patchRefused", "recheck", "cancel", "done"}
Answers == {"none", "ok", "refused", "error"}
Statuses == {"active", "canceled"}
Sub == [status : Statuses, refused : BOOLEAN, first : BOOLEAN]
Charge == [sub : Ids, status : {"open", "failed"}, created : {"open", "failed"}]
Key == [held : BOOLEAN, resp : Ids, for : Ids, during : SUBSET Calls]
NoKey == [held |-> FALSE, resp |-> 0, for |-> 0, during |-> {}]
NoPay == [id |-> 0, status |-> "open"]
Max(S) == CHOOSE x \in S : \A y \in S : x >= y

TypeOK ==
  /\ subs \in Seq(Sub) /\ Len(subs) <= Cardinality(Calls)
  /\ charges \in Seq(Charge) /\ Len(charges) <= Cardinality(Calls)
  /\ keys \in [{"sub", "charge"} -> Key]
  /\ pc \in [Calls -> Steps]
  /\ answer \in [Calls -> Answers]
  /\ target \in [Calls -> Ids]
  /\ snap \in [Calls -> [refused : BOOLEAN, first : BOOLEAN]]
  /\ seen \in [Calls -> Statuses]
  /\ pay \in [Calls -> [id : Ids, status : {"open", "failed"}]]

Running == {c \in Calls : pc[c] \notin {"idle", "done"}}

(* ListSubscriptions, GetSubscription and CancelSubscription show a        *)
(* subscription that carries the module's metadata, unless it carries the  *)
(* refused mark and Mollie has ended it (records.ts:142-151, 322-323,      *)
(* changes.ts:65-66). A caller's cancel mark keeps a refused one shown;    *)
(* no call here cancels. Every subscription here carries the metadata.     *)
Listed(i) == ~(subs[i].refused /\ subs[i].status = "canceled")

Init ==
  /\ subs = <<>>
  /\ charges = <<>>
  /\ keys = [k \in {"sub", "charge"} |-> NoKey]
  /\ pc = [c \in Calls |-> "idle"]
  /\ answer = [c \in Calls |-> "none"]
  /\ target = [c \in Calls |-> 0]
  /\ snap = [c \in Calls |-> [refused |-> FALSE, first |-> FALSE]]
  /\ seen = [c \in Calls |-> "active"]
  /\ pay = [c \in Calls |-> NoPay]

Go(c, step) == /\ pc' = [pc EXCEPT ![c] = step]
               /\ UNCHANGED answer
Answer(c, a) == /\ pc' = [pc EXCEPT ![c] = "done"]
                /\ answer' = [answer EXCEPT ![c] = a]

(* The call holds the first charge j: a failed one goes to failedStep,     *)
(* another to recording it as the first period.                           *)
Hold(c, j, status, failedStep) ==
  /\ pay' = [pay EXCEPT ![c] = [id |-> j, status |-> status]]
  /\ Go(c, IF status = "failed" THEN failedStep ELSE "patchFirst")

(* existingFor lists the customer's subscriptions, newest first, and takes *)
(* the first whose metadata carries the key. ValidateSubscriptionRequest   *)
(* and the mandate read before it change nothing, so a failure there is a  *)
(* call that never started (creation.ts:377-388).                          *)
List(c) ==
  /\ pc[c] = "idle"
  /\ IF subs = <<>>                                  \* creation.ts:125-138, 181-182
     THEN /\ Go(c, "postSub")
          /\ UNCHANGED target
     ELSE /\ Go(c, "get")
          /\ target' = [target EXCEPT ![c] = Len(subs)]
  /\ UNCHANGED <<subs, charges, keys, snap, seen, pay>>

(* POST /customers/{id}/subscriptions with the key. A remembered key       *)
(* answers what it answered first. Otherwise Mollie refuses a description  *)
(* an active subscription of the customer already has (the same request   *)
(* has the same description, creation.ts:157), and stores that 422 too.    *)
PostSub(c) ==
  LET fresh == ~keys.sub.held
      taken == \E i \in 1..Len(subs) : subs[i].status = "active"
      id == IF ~fresh THEN keys.sub.resp ELSE IF taken THEN 0 ELSE Len(subs) + 1
  IN
  /\ pc[c] = "postSub"
  /\ subs' = IF fresh /\ ~taken                      \* creation.ts:183-192
             THEN Append(subs, [status |-> "active", refused |-> FALSE, first |-> FALSE])
             ELSE subs
  /\ keys' = IF fresh
             THEN [keys EXCEPT !.sub = [held |-> TRUE, resp |-> id, for |-> 0, during |-> Running]]
             ELSE keys
  /\ \E lost \in BOOLEAN :
       IF id = 0 \/ lost
       THEN /\ Answer(c, "error")
            /\ UNCHANGED target
       ELSE /\ Go(c, "get")
            /\ target' = [target EXCEPT ![c] = id]
  /\ UNCHANGED <<charges, snap, seen, pay>>

(* create GETs the subscription, and settleFirstPeriod reads its metadata. *)
Get(c) ==
  LET s == subs[target[c]]
  IN
  /\ pc[c] = "get"
  /\ snap' = [snap EXCEPT ![c] = [refused |-> s.refused, first |-> s.first]]
  /\ seen' = [seen EXCEPT ![c] = s.status]
  /\ IF s.refused THEN Go(c, "cancel")                \* creation.ts:342-345
     ELSE IF s.first THEN Answer(c, "ok")            \* creation.ts:346, 357
     ELSE Go(c, "earlier")
  /\ UNCHANGED <<subs, charges, keys, target, pay>>

(* earlierCharge reads the customer's recent payments, newest first, and   *)
(* takes the first whose metadata names this subscription. It reads the  *)
(* charge as it is now, not as Mollie answered its creation, so a failed  *)
(* one goes to Recheck.                                                    *)
Earlier(c) ==
  LET mine == {j \in 1..Len(charges) : charges[j].sub = target[c]}
  IN
  /\ pc[c] = "earlier"
  /\ IF mine = {}                                    \* creation.ts:232-248, 347
     THEN /\ Go(c, "postCharge")
          /\ UNCHANGED pay
     ELSE Hold(c, Max(mine), charges[Max(mine)].status, "recheck")  \* creation.ts:348-352
  /\ UNCHANGED <<subs, charges, keys, target, snap, seen>>

(* POST /payments with the key plus ":first-period". A remembered key      *)
(* answers its first response, with the status the charge had then; the   *)
(* same key on a request for another subscription is a 400.                *)
PostCharge(c) ==
  LET fresh == ~keys.charge.held
      j == IF fresh THEN Len(charges) + 1 ELSE keys.charge.resp
      outcomes == IF ~fresh THEN {charges[j].created}
                  ELSE IF Declines THEN {"open", "failed"} ELSE {"open"}
  IN
  /\ pc[c] = "postCharge"
  /\ IF ~fresh /\ keys.charge.for /= target[c]
     THEN /\ Answer(c, "error")
          /\ UNCHANGED <<charges, keys, pay>>
     ELSE \E status \in outcomes :                   \* creation.ts:250-275
          /\ charges' = IF fresh
                        THEN Append(charges, [sub |-> target[c], status |-> status, created |-> status])
                        ELSE charges
          /\ keys' = IF fresh
                     THEN [keys EXCEPT !.charge = [held |-> TRUE, resp |-> j, for |-> target[c], during |-> Running]]
                     ELSE keys
          /\ \E lost \in BOOLEAN :
               IF lost
               THEN /\ Answer(c, "error")
                    /\ UNCHANGED pay
               ELSE Hold(c, j, status, "patchRefused")  \* creation.ts:351-353
  /\ UNCHANGED <<subs, target, snap, seen>>

(* updateOwn PATCHes the whole metadata: the copy the call's GET read,     *)
(* plus firstPayment (metadata.ts MergeOwn). Mollie refuses to update a    *)
(* canceled subscription.                                                  *)
PatchFirst(c) ==
  LET i == target[c]
  IN
  /\ pc[c] = "patchFirst"
  /\ IF subs[i].status = "canceled"                  \* creation.ts:195-208, 354
     THEN /\ Answer(c, "error")
          /\ UNCHANGED subs
     ELSE /\ subs' = [subs EXCEPT ![i] = [@ EXCEPT !.refused = snap[c].refused, !.first = TRUE]]
          /\ \E lost \in BOOLEAN : Answer(c, IF lost THEN "error" ELSE "ok")
  /\ UNCHANGED <<charges, keys, target, snap, seen, pay>>

(* refuse PATCHes the copy the call's GET read, plus refused, then cancels *)
(* the subscription as that PATCH answered it. Only a call holding        *)
(* Mollie's answer to creating the charge gets here.                       *)
PatchRefused(c) ==
  LET i == target[c]
  IN
  /\ pc[c] = "patchRefused"
  /\ IF subs[i].status = "canceled"                  \* creation.ts:295-303
     THEN /\ Answer(c, "error")
          /\ UNCHANGED <<subs, seen>>
     ELSE /\ subs' = [subs EXCEPT ![i] = [@ EXCEPT !.refused = TRUE, !.first = snap[c].first]]
          /\ \E lost \in BOOLEAN :
               IF lost
               THEN /\ Answer(c, "error")
                    /\ UNCHANGED seen
               ELSE /\ Go(c, "cancel")
                    /\ seen' = [seen EXCEPT ![c] = subs[i].status]
  /\ UNCHANGED <<charges, keys, target, snap, pay>>

(* settleFailedEarlierCharge: the charge may have failed after another    *)
(* call recorded it and returned the subscription, so the call GETs the   *)
(* subscription again, returns it if a call recorded the charge, and      *)
(* otherwise cancels it without writing its metadata.                     *)
Recheck(c) ==
  LET s == subs[target[c]]
  IN
  /\ pc[c] = "recheck"
  /\ seen' = [seen EXCEPT ![c] = s.status]
  /\ IF s.first THEN Answer(c, "ok")                 \* creation.ts:321-329
     ELSE Go(c, "cancel")                            \* creation.ts:330-331
  /\ UNCHANGED <<subs, charges, keys, target, snap, pay>>

(* cancelRefused skips a subscription it last read as ended, else DELETEs *)
(* it; Mollie refuses to cancel a canceled one. Then the call rejects with *)
(* SubscriptionPaymentError.                                               *)
Cancel(c) ==
  LET i == target[c]
  IN
  /\ pc[c] = "cancel"
  /\ IF seen[c] = "canceled"                         \* creation.ts:279-288
     THEN /\ Answer(c, "refused")
          /\ UNCHANGED subs
     ELSE IF subs[i].status = "canceled"
     THEN /\ Answer(c, "error")
          /\ UNCHANGED subs
     ELSE /\ subs' = [subs EXCEPT ![i].status = "canceled"]
          /\ \E lost \in BOOLEAN : Answer(c, IF lost THEN "error" ELSE "refused")
  /\ UNCHANGED <<charges, keys, target, snap, seen, pay>>

(* A request fails before Mollie applies it, a read fails, or the process *)
(* stops: the call ends without its next request taking effect.           *)
Fail(c) ==
  /\ pc[c] \notin {"idle", "done"}
  /\ Answer(c, "error")
  /\ UNCHANGED <<subs, charges, keys, target, snap, seen, pay>>

(* An hour after storing it, Mollie forgets a key. *)
Expire(k) ==
  /\ keys[k].held
  /\ keys[k].during \cap Running = {}
  /\ keys' = [keys EXCEPT ![k] = NoKey]
  /\ UNCHANGED <<subs, charges, pc, answer, target, snap, seen, pay>>

(* Mollie settles a charge after it answered: an open one can fail. *)
LateFailure(j) ==
  /\ LateFailures
  /\ j <= Len(charges)
  /\ charges[j].status = "open"
  /\ charges' = [charges EXCEPT ![j].status = "failed"]
  /\ UNCHANGED <<subs, keys, pc, answer, target, snap, seen, pay>>

(* Every call has answered. *)
Settled ==
  /\ \A c \in Calls : pc[c] = "done"
  /\ UNCHANGED vars

Next ==
  \/ \E c \in Calls :
       \/ List(c) \/ PostSub(c) \/ Get(c) \/ Earlier(c)
       \/ PostCharge(c) \/ PatchFirst(c) \/ PatchRefused(c) \/ Recheck(c)
       \/ Cancel(c) \/ Fail(c)
  \/ \E k \in {"sub", "charge"} : Expire(k)
  \/ \E j \in 1..Cardinality(Calls) : LateFailure(j)
  \/ Settled

Spec == Init /\ [][Next]_vars

(* -------------------------------- rules -------------------------------- *)

(* At most one Mollie subscription carries the key. *)
AtMostOneSubscriptionPerKey == Len(subs) <= 1

(* At most one first-period charge exists for the key. *)
AtMostOneFirstChargePerKey == Len(charges) <= 1

(* With no call running, every subscription Mollie would bill is one the  *)
(* module lists, reads and can cancel.                                     *)
NoHiddenActiveSubscription ==
  Running = {} => \A i \in 1..Len(subs) : subs[i].status = "active" => Listed(i)

(* A call that rejected with SubscriptionPaymentError left its            *)
(* subscription canceled at Mollie.                                        *)
RefusedIsNotBilling ==
  \A c \in Calls : answer[c] = "refused" => subs[target[c]].status = "canceled"

(* A call that resolved with a subscription left one the module lists.    *)
CreatedIsListed ==
  \A c \in Calls : answer[c] = "ok" => Listed(target[c])

=============================================================================
