/**
 * 模型链节点的单点参数表。
 *
 * 旧 `buildWorkflow` 与官方 Turbo 的 `buildDistilledModelChain` 曾各自复制
 * LoRA / Cache / TE-Speed / Speedup / BlockCache / FA 的全部参数；后来者改一个
 * 阈值，另一条链就会悄悄漂移。这里只抽“节点怎么造”，不抽“节点怎么连”，
 * 节点 ID 与顺序仍由调用方掌握，重构风险最小。
 */

export function loraNode(modelRef, loraName, strength) {
  return {
    class_type: 'LoraLoaderModelOnly',
    inputs: {
      model: [modelRef, 0],
      lora_name: loraName,
      strength_model: Number.isFinite(strength) ? strength : 1.0,
    },
  }
}

export function fluxShiftNode(plan, modelRef, width, height) {
  return {
    class_type: 'ModelSamplingFlux',
    inputs: {
      model: [modelRef, 0],
      max_shift: plan.maxShift,
      base_shift: plan.baseShift,
      width: Math.max(1, Math.round(Number(width) || 1024)),
      height: Math.max(1, Math.round(Number(height) || 1024)),
    },
  }
}

export function prefixCacheNode(cfg, modelRef) {
  return {
    class_type: 'QwenImage21Cache',
    inputs: {
      model: [modelRef, 0],
      device: cfg.qwenCacheDevice ?? 'auto',
      dtype: cfg.qwenCacheDtype ?? 'int8',
    },
  }
}

export function teSpeedNode(cfg, modelRef) {
  return {
    class_type: 'TESpeedQwenImage21',
    inputs: {
      model: [modelRef, 0],
      attention: cfg.teSpeedAttention ?? 'kitchen_int8',
      step_cache: cfg.teSpeedStepCache ?? 'te_predictor',
      reuse_threshold: Number.isFinite(cfg.teSpeedThreshold) ? cfg.teSpeedThreshold : 0.06,
      start_percent: Number.isFinite(cfg.teSpeedStartPercent) ? cfg.teSpeedStartPercent : 0.0,
      end_percent: Number.isFinite(cfg.teSpeedEndPercent) ? cfg.teSpeedEndPercent : 1.0,
      predictor_error_limit: Number.isFinite(cfg.teSpeedErrorLimit) ? cfg.teSpeedErrorLimit : 0.08,
      verbose: cfg.teSpeedVerbose === true,
    },
  }
}

export function speedupNode(cfg, modelRef) {
  return {
    class_type: 'QwenImage21Speedup',
    inputs: {
      model: [modelRef, 0],
      enable_cache: true,
      cache_threshold: Number.isFinite(cfg.speedupCacheThreshold) ? cfg.speedupCacheThreshold : 0.30,
      target_error: Number.isFinite(cfg.speedupTargetError) ? cfg.speedupTargetError : 0.05,
      cache_start_percent: Number.isFinite(cfg.speedupStartPercent) ? cfg.speedupStartPercent : 0.15,
      cache_end_percent: Number.isFinite(cfg.speedupEndPercent) ? cfg.speedupEndPercent : 0.90,
      max_consecutive_skips: Number.isFinite(cfg.speedupMaxConsecutiveSkips)
        ? Math.trunc(cfg.speedupMaxConsecutiveSkips) : 3,
      forecast: cfg.speedupForecast ?? 'first',
      cache_device: cfg.speedupCacheDevice ?? 'auto',
      debug_log: cfg.speedupDebugLog === true,
    },
  }
}

export function blockCacheNode(cfg, modelRef) {
  return {
    class_type: 'QwenImage21BlockCacheT8',
    inputs: {
      model: [modelRef, 0],
      residual_diff_threshold: Number.isFinite(cfg.blockCacheThreshold) ? cfg.blockCacheThreshold : 0.03,
      start_percent: Number.isFinite(cfg.blockCacheStartPercent) ? cfg.blockCacheStartPercent : 0.1,
      end_percent: Number.isFinite(cfg.blockCacheEndPercent) ? cfg.blockCacheEndPercent : 0.9,
      max_consecutive_hits: Number.isFinite(cfg.blockCacheMaxHits) ? Math.trunc(cfg.blockCacheMaxHits) : 2,
      cache_device: cfg.blockCacheDevice ?? 'cpu',
      metric_stride: Number.isFinite(cfg.blockCacheMetricStride) ? Math.trunc(cfg.blockCacheMetricStride) : 8,
      max_cache_mb: Number.isFinite(cfg.blockCacheMaxMb) ? Math.trunc(cfg.blockCacheMaxMb) : 1024,
      threshold_mode: cfg.blockCacheThresholdMode ?? 'two_stage',
      split_ratio: Number.isFinite(cfg.blockCacheSplitRatio) ? cfg.blockCacheSplitRatio : 0.35,
      late_threshold: Number.isFinite(cfg.blockCacheLateThreshold) ? cfg.blockCacheLateThreshold : 0.15,
    },
  }
}

export function rdna3FaNode(modelRef) {
  return { class_type: 'ApplyRDNA3FlashAttention', inputs: { model: [modelRef, 0] } }
}
