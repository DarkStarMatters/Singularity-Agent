-- GCP Types
-- Formal model of Google Cloud Platform types
-- Aligned with the AWS model pattern (tools/gokujo/AWS/Types.lean)

namespace GCP

-- ============================================
-- Primitive Types
-- ============================================

-- GCP Project ID
def ProjectId := String

-- GCP Region
def Region := String

-- GCP Access Token
def AccessToken := String

-- GCP API Key
def APIKey := String

-- GCP Request ID
def RequestId := String

-- ISO 8601 Timestamp
def ISO8601Timestamp := String

-- Unix Timestamp
def UnixTimestamp := Nat

-- ============================================
-- GCP Service Types
-- ============================================

-- GCP Service names
inductive Service
  | CloudFunctions
  | CloudRun
  | ComputeEngine
  | Container
  | CloudStorage
  | CloudSQL
  | CloudLogging
  | CloudMonitoring
  | CloudPubSub
  | CloudScheduler
  | CloudSchedulerJob
  | CloudBuild
  | ArtifactRegistry
  | BigQuery
  | CloudSourceRepositories
  deriving Repr, DecidableEq

-- ============================================
-- Cloud Functions Types
-- ============================================

-- Cloud Function Name
def CloudFunctionName := String

-- Cloud Function Entry Point
def CloudFunctionEntryPoint := String

-- Cloud Function Trigger
structure CloudFunctionTrigger where
  triggerType : String  -- "http", "pubsub", "schedule", "event_arc"
  triggerData : String

-- Cloud Function HTTP Trigger
structure CloudFunctionHttpTrigger where
  aliveTimeout : Nat
  uri          : String

-- Cloud Function PubSub Trigger
structure CloudFunctionPubSubTrigger where
  topic : String

-- Cloud Function Schedule Trigger
structure CloudFunctionScheduleTrigger where
  schedule : String

-- Cloud Function Runtime
inductive CloudFunctionRuntime
  | NodeJS18
  | NodeJS20
  | Python311
  | Python312
  | Go121
  | Go122
  | Java17
  | Ruby32
  deriving Repr, DecidableEq

-- Cloud Function Configuration
structure CloudFunctionConfig where
  functionName : CloudFunctionName
  entryPoint   : String
  runtime      : CloudFunctionRuntime
  availableMemory : Nat  -- MB
  timeout      : Nat  -- seconds
  environmentVariables : List (String × String)
  trigger        : Option CloudFunctionTrigger

-- ============================================
-- Cloud Run Types
-- ============================================

-- Cloud Run Service Name
def CloudRunServiceName := String

-- Cloud Run Configuration
structure CloudRunConfig where
  serviceName : CloudRunServiceName
  region      : Region
  cpu         : Nat  -- millicores
  memory      : Nat  -- MB
  maxInstances : Nat
  minInstances : Nat
  timeout     : Nat
  timeoutAction : String  -- "terminate", "continue"

-- Cloud Run Revision
structure CloudRunRevision where
  revisionName : String
  version      : Nat
  state        : String  -- "PREPARING", "RUNNING", "UPDATING", "FAILED"
  url          : String
  instanceCount : Nat

-- ============================================
-- Compute Engine Types
-- ============================================

-- Machine Type
def MachineType := String

-- Disk Size (GB)
def DiskSize := Nat

-- Disk Type
inductive DiskType
  | PD_Standard
  | PD_Balanced
  | PD_SSD
  | LocalSSD

-- Instance Config
def InstanceConfig := String

-- ============================================
-- Container Types
-- ============================================

-- Cluster Name
def ClusterName := String

-- Node Pool Name
def NodePoolName := String

-- ============================================
-- Cloud Storage Types
-- ============================================

-- Bucket Name
def BucketName := String

-- Object Name
def ObjectName := String

-- Object Version
def ObjectVersion := String

-- Bucket Storage Class
inductive StorageClass
  | STANDARD
  | NEARLINE
  | COLDLINE
  | DUAL_REGION
  | REGIONAL

-- ============================================
-- Cloud SQL Types
-- ============================================

-- Database Version
def DatabaseVersion := String

-- Configuration Type
def ConfigurationType := String

-- ============================================
-- Cloud Logging Types
-- ============================================

-- Log Name
def LogName := String

-- Log Entry
structure LogEntry where
  resource  : String
  severity  : String
  textPayload : String
  jsonPayload : String

-- ============================================
-- Cloud Monitoring Types
-- ============================================

-- Metric Name
def MetricName := String

-- Metric Value
def MetricValue := Double

-- ============================================
-- Cloud PubSub Types
-- ============================================

-- Topic Name
def TopicName := String

-- Subscription Name
def SubscriptionName := String

-- ============================================
-- Cloud Scheduler Types
-- ============================================

-- Job Name
def JobName := String

-- Schedule
def Schedule := String

-- ============================================
-- Cloud Build Types
-- ============================================

-- Build ID
def BuildId := String

-- Build Status
inductive BuildStatus
  | QUEUED
  | RUNNING
  | SUCCESS
  | FAILURE
  | TIMEOUT
  | CANCELLED

-- Build Trigger
structure BuildTrigger where
  triggerId     : String
  triggerTemplate : BuildTriggerTemplate

structure BuildTriggerTemplate where
  triggerName : String
  pauseTime   : Nat
  retry       : Bool

-- ============================================
-- Artifact Registry Types
-- ============================================

-- Repository Name
def RepositoryName := String

-- Repository Format
inductive RepositoryFormat
  | DOCKER
  | MAVEN
  | NPM
  | PYPI
  | GOLANG

-- ============================================
-- BigQuery Types
-- ============================================

-- Dataset Name
def DatasetName := String

-- Table Name
def TableName := String

-- Schema Field
structure SchemaField where
  name    : String
  type_     : String
  mode      : String  -- "NULLABLE", "REQUIRED", "REPEATED"
  description : String

-- ============================================
-- Cloud Source Repositories Types
-- ============================================

-- Repository ID
def RepositoryId := String