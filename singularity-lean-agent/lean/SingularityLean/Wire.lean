/-
  SingularityLean.Wire — lean-link/1, the bytes a certified prover call is tagged over.

  lean-worker's `Protocol.Core` models a call to a prover node and the
  certificate that answers it, with an idealised tag. To run that protocol
  between real machines, both ends have to tag the *same bytes*, so this file
  fixes them: every field is written `<utf8 byte length>:<text>,`, which no
  module name, declaration name or failure reason can make ambiguous.

  The TypeScript side (`src/wire.ts`) implements the same functions, and the
  examples below are the vectors in `vectors/link-v1.json`, checked here by the
  Lean kernel and there by `test/vectors.test.ts`. A Lean-native node that
  encodes with these definitions interoperates with Singularity by
  construction; if either side drifts, one of the two checks fails.

  The tag itself is HMAC-SHA256 over these bytes, under a 32-byte key. That
  part lives on the TypeScript side: it is the concrete instantiation of the
  upstream model's `macTag`, which the model leaves abstract.
-/

namespace LeanLink

def version : String := "lean-link/1"

/-- One length-prefixed field. The length counts UTF-8 bytes, not characters. -/
def field (s : String) : String := toString s.utf8ByteSize ++ ":" ++ s ++ ","

def natField (n : Nat) : String := field (toString n)

/-- The work a caller can ask of a prover node (upstream `P2P.Job`, digests as SHA-256 hex). -/
inductive Job where
  | proveGoal (module decl sourceDigest : String)
  | checkProof (artifactDigest : String)
  | runExe (exe argvDigest : String)
  deriving DecidableEq, Repr

/-- What came back (upstream `P2P.Outcome`). -/
inductive Outcome where
  | proved (axioms : List String)
  | failed (reason : String)
  | exited (code : Nat) (outDigest : String)
  deriving DecidableEq, Repr

structure CallBody where
  client     : String
  server     : String
  nonce      : Nat
  job        : Job
  fuelBudget : Nat
  deriving DecidableEq, Repr

structure Certificate where
  server        : String
  client        : String
  nonce         : Nat
  job           : Job
  outcome       : Outcome
  kernelChecked : Bool
  fuelUsed      : Nat
  deriving DecidableEq, Repr

def encodeJob : Job → String
  | .proveGoal m d s => field "proveGoal" ++ field m ++ field d ++ field s
  | .checkProof a    => field "checkProof" ++ field a
  | .runExe e a      => field "runExe" ++ field e ++ field a

def encodeOutcome : Outcome → String
  | .proved axs  => field "proved" ++ natField axs.length ++ String.join (axs.map field)
  | .failed r    => field "failed" ++ field r
  | .exited c d  => field "exited" ++ natField c ++ field d

/-- The bytes a call is tagged over, with the caller's key. -/
def encodeCallBody (b : CallBody) : String :=
  field version ++ field "call" ++ field b.client ++ field b.server ++
  natField b.nonce ++ encodeJob b.job ++ natField b.fuelBudget

/-- The bytes a certificate is tagged over, with the node's key. -/
def encodeCertificate (c : Certificate) : String :=
  field version ++ field "cert" ++ field c.server ++ field c.client ++
  natField c.nonce ++ encodeJob c.job ++ encodeOutcome c.outcome ++
  field (if c.kernelChecked then "1" else "0") ++ natField c.fuelUsed

/-- What a `runExe` job's `argvDigest` is the SHA-256 of. -/
def encodeArgv (argv : List String) : String :=
  natField argv.length ++ String.join (argv.map field)

/-! ### Vectors — identical to `vectors/link-v1.json` -/

def sourceDigest : String := "1a724eba004db7c651b5f3da77d41df9aec05e9ce036aaa7c906e5b85e75d801"

def sampleJob : Job := .proveGoal "RequestProject.Protocol.Server" "P2P.replay_rejected" sourceDigest

def sampleBody : CallBody :=
  { client := "singularity", server := "lean-worker", nonce := 7, job := sampleJob, fuelBudget := 300 }

def sampleCert : Certificate :=
  { server := "lean-worker", client := "singularity", nonce := 7, job := sampleJob
  , outcome := .proved ["propext"], kernelChecked := true, fuelUsed := 300 }

def failedCert : Certificate :=
  { sampleCert with outcome := .failed "λ: a,b|c", kernelChecked := false }

-- vector: call
example : encodeCallBody sampleBody =
    "11:lean-link/1,4:call,11:singularity,11:lean-worker,1:7,9:proveGoal,30:RequestProject.Protocol.Server,19:P2P.replay_rejected,64:1a724eba004db7c651b5f3da77d41df9aec05e9ce036aaa7c906e5b85e75d801,3:300," := by
  decide +kernel

-- vector: certificate
example : encodeCertificate sampleCert =
    "11:lean-link/1,4:cert,11:lean-worker,11:singularity,1:7,9:proveGoal,30:RequestProject.Protocol.Server,19:P2P.replay_rejected,64:1a724eba004db7c651b5f3da77d41df9aec05e9ce036aaa7c906e5b85e75d801,6:proved,1:1,7:propext,1:1,3:300," := by
  decide +kernel

-- vector: failedCertificate
example : encodeCertificate failedCert =
    "11:lean-link/1,4:cert,11:lean-worker,11:singularity,1:7,9:proveGoal,30:RequestProject.Protocol.Server,19:P2P.replay_rejected,64:1a724eba004db7c651b5f3da77d41df9aec05e9ce036aaa7c906e5b85e75d801,6:failed,9:λ: a,b|c,1:0,3:300," := by
  decide +kernel

-- vector: argv
example : encodeArgv ["--check", "é"] = "1:2,7:--check,2:é," := by
  decide +kernel

/-! ### Properties the TypeScript side relies on -/

/-- No call is ever tagged over the same bytes as any certificate: the second
    field is `call` in one and `cert` in the other. With one key on both sides
    of a link, this is what stops a tag on a call being replayed as a tag on a
    certificate, whatever either one contains. -/
theorem call_ne_cert (b : CallBody) (c : Certificate) : encodeCallBody b ≠ encodeCertificate c := by
  have hc : (field version).toList ++ (field "call").toList = "11:lean-link/1,4:call,".toList := by
    decide +kernel
  have ht : (field version).toList ++ (field "cert").toList = "11:lean-link/1,4:cert,".toList := by
    decide +kernel
  intro h
  have hl := congrArg String.toList h
  simp only [encodeCallBody, encodeCertificate, String.toList_append, List.append_assoc] at hl
  rw [← List.append_assoc (field version).toList (field "call").toList, hc,
      ← List.append_assoc (field version).toList (field "cert").toList, ht] at hl
  exact absurd (List.append_inj hl (by decide +kernel)).1 (by decide +kernel)

/-- Lengths count bytes: `λ` is two bytes in UTF-8, so a character count would
    put the wrong prefix on any non-ASCII field. -/
example : field "λ" = "2:λ," := by decide +kernel

end LeanLink
