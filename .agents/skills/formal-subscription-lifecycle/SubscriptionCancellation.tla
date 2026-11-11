----------------------- MODULE SubscriptionCancellation -----------------------
(***************************************************************************)
(* CancelSubscription of @antelopejs/mollie on the subscriptions of one    *)
(* customer, with Mollie as the environment. Each subscription gets a      *)
(* period_end cancellation and a now cancellation, each under its own      *)
(* idempotency key and sent once, in any order. Each Mollie request is one *)
(* atomic step that can fail before Mollie applies it, or after, with the  *)
(* answer lost. Time stays inside the current period, so a period_end      *)
(* cancellation has not ended yet. Every subscription starts active,       *)
(* charged and listed.                                                     *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Subs  \* the customer's subscriptions

Timings == {"period_end", "now"}
Calls == Subs \X Timings
Keys == Calls
NoKey == <<"none", "none">>
KeyOf(x) == x

VARIABLES
  status,  \* each subscription's Mollie status
  mark,    \* the cancel mark in each subscription's metadata: timing and key
  ended,   \* the customer's endedEarly map: the key whose early end each subscription carries
  pc,      \* where each call is
  answer,  \* what each call answered
  copy     \* the endedEarly map as each call's customer GET read it, until the call ends

vars == <<status, mark, ended, pc, answer, copy>>

Steps == {"idle", "patchMark", "delete", "readCustomer", "patchCustomer", "done"}
Answers == {"none", "ok", "endedEarly", "error"}
EndedMap == [Subs -> Keys \cup {NoKey}]
NoCopy == [s \in Subs |-> NoKey]

TypeOK ==
  /\ status \in [Subs -> {"active", "canceled"}]
  /\ mark \in [Subs -> [timing : Timings \cup {"none"}, key : Keys \cup {NoKey}]]
  /\ ended \in EndedMap
  /\ pc \in [Calls -> Steps]
  /\ answer \in [Calls -> Answers]
  /\ copy \in [Calls -> EndedMap]

Init ==
  /\ status = [s \in Subs |-> "active"]
  /\ mark = [s \in Subs |-> [timing |-> "none", key |-> NoKey]]
  /\ ended = [s \in Subs |-> NoKey]
  /\ pc = [x \in Calls |-> "idle"]
  /\ answer = [x \in Calls |-> "none"]
  /\ copy = [x \in Calls |-> NoCopy]

Go(x, step) == /\ pc' = [pc EXCEPT ![x] = step]
               /\ UNCHANGED answer
Answer(x, a) == /\ pc' = [pc EXCEPT ![x] = "done"]
                /\ answer' = [answer EXCEPT ![x] = a]

(* What ToSubscription reports: canceled at Mollie with a period_end mark *)
(* and no early end is cancelAtPeriodEnd; any other canceled one has      *)
(* ended (mapping.ts:302-319).                                             *)
EndingLater(s) == status[s] = "canceled" /\ mark[s].timing = "period_end" /\ ended[s] = NoKey
HasEnded(s) == status[s] = "canceled" /\ ~EndingLater(s)

(* LoadRecord reads the subscription and, when it is canceled with a      *)
(* period_end mark, the customer's early ends; Mollie refuses any change  *)
(* to a canceled subscription, so the two reads are one step here. Then   *)
(* cancel decides.                                                         *)
Load(x) ==
  LET s == x[1]
      t == x[2]
      same == mark[s].key = KeyOf(x) \/ ended[s] = KeyOf(x)
  IN
  /\ pc[x] = "idle"
  /\ IF HasEnded(s)                                  \* changes.ts:133-135, 77-96
     THEN Answer(x, IF same THEN "ok" ELSE "error")
     ELSE IF EndingLater(s) /\ t = "period_end"     \* changes.ts:136
     THEN Answer(x, "ok")
     ELSE IF EndingLater(s)                          \* changes.ts:137-138
     THEN Go(x, "readCustomer")
     ELSE Go(x, "patchMark")                         \* changes.ts:139-146
  /\ UNCHANGED <<status, mark, ended, copy>>

(* cancelAtMollie PATCHes the metadata it loaded plus the cancel mark.    *)
PatchMark(x) ==
  LET s == x[1]
  IN
  /\ pc[x] = "patchMark"
  /\ IF status[s] = "canceled"                       \* changes.ts:105-109
     THEN /\ Answer(x, "error")
          /\ UNCHANGED mark
     ELSE /\ mark' = [mark EXCEPT ![s] = [timing |-> x[2], key |-> KeyOf(x)]]
          /\ \E lost \in BOOLEAN : IF lost THEN Answer(x, "error") ELSE Go(x, "delete")
  /\ UNCHANGED <<status, ended, copy>>

(* Then it DELETEs the subscription and reads it back. *)
Delete(x) ==
  LET s == x[1]
  IN
  /\ pc[x] = "delete"
  /\ IF status[s] = "canceled"                       \* changes.ts:110-111
     THEN /\ Answer(x, "error")
          /\ UNCHANGED status
     ELSE /\ status' = [status EXCEPT ![s] = "canceled"]
          /\ \E lost \in BOOLEAN : Answer(x, IF lost THEN "error" ELSE "ok")
  /\ UNCHANGED <<mark, ended, copy>>

(* endEarly: RecordEarlyEnd reads the customer... *)
ReadCustomer(x) ==
  /\ pc[x] = "readCustomer"
  /\ copy' = [copy EXCEPT ![x] = ended]              \* records.ts:234
  /\ Go(x, "patchCustomer")
  /\ UNCHANGED <<status, mark, ended>>

(* ...and PATCHes the customer's whole metadata: the map it read, plus     *)
(* this subscription's early end. Then it reads the subscription back.    *)
PatchCustomer(x) ==
  /\ pc[x] = "patchCustomer"
  /\ ended' = [copy[x] EXCEPT ![x[1]] = KeyOf(x)]    \* records.ts:235-243
  /\ copy' = [copy EXCEPT ![x] = NoCopy]
  /\ \E lost \in BOOLEAN : Answer(x, IF lost THEN "error" ELSE "endedEarly")
  /\ UNCHANGED <<status, mark>>

(* A request fails before Mollie applies it, a read fails, or the process *)
(* stops: the call ends without its next request taking effect.           *)
Fail(x) ==
  /\ pc[x] \notin {"idle", "done"}
  /\ Answer(x, "error")
  /\ copy' = [copy EXCEPT ![x] = NoCopy]
  /\ UNCHANGED <<status, mark, ended>>

(* Every call has answered. *)
Settled ==
  /\ \A x \in Calls : pc[x] = "done"
  /\ UNCHANGED vars

Next ==
  \/ \E x \in Calls :
       \/ Load(x) \/ PatchMark(x) \/ Delete(x) \/ ReadCustomer(x)
       \/ PatchCustomer(x) \/ Fail(x)
  \/ Settled

Spec == Init /\ [][Next]_vars

(* -------------------------------- rules -------------------------------- *)

(* A `now` cancellation that returned after recording an early end left   *)
(* that early end on the customer.                                         *)
EarlyEndNotLost ==
  \A x \in Calls : answer[x] = "endedEarly" => ended[x[1]] /= NoKey

=============================================================================
