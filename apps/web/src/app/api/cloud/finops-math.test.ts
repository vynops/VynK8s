import { describe, expect, it } from 'vitest'
import { getEffectivePodRequests, parseCapGiB, parseCpuMillis, parseKubernetesQuantity, parseMemMiB } from './finops-math'
import { calculateWeightedEfficiency } from './finops-math'

describe('FinOps Kubernetes resource quantities', () => {
  it('parses decimal, binary, and exponent quantities', () => {
    expect(parseCpuMillis('250m')).toBe(250)
    expect(parseCpuMillis('0.5')).toBe(500)
    expect(parseCpuMillis('500u')).toBe(0.5)
    expect(parseMemMiB('1Gi')).toBe(1024)
    expect(parseMemMiB('1G')).toBeCloseTo(953.674, 2)
    expect(parseCapGiB('1Ti')).toBe(1024)
    expect(parseKubernetesQuantity('1e3')).toBe(1000)
  })

  it('counts init-container scheduling peaks and pod overhead once', () => {
    const result = getEffectivePodRequests({
      spec: {
        containers: [{ resources: { requests: { cpu: '500m', memory: '512Mi' } } }],
        initContainers: [
          { resources: { requests: { cpu: '1', memory: '1Gi' } } },
          { restartPolicy: 'Always', resources: { requests: { cpu: '100m', memory: '128Mi' } } },
        ],
        overhead: { cpu: '50m', memory: '64Mi' },
      },
    })
    expect(result.cpuMillis).toBe(1050)
    expect(result.memMiB).toBe(1088)
  })

  it('weights cluster efficiency by request cost and preserves missing measurements', () => {
    expect(calculateWeightedEfficiency({
      cpuRequested: 10, cpuActual: 5,
      memoryRequestedGiB: 1, memoryActualGiB: 1,
      cpuRate: 0.048, memoryRate: 0.006,
    })).toBe(51)
    expect(calculateWeightedEfficiency({
      cpuRequested: 1, cpuActual: null,
      memoryRequestedGiB: 0, memoryActualGiB: null,
      cpuRate: 0.048, memoryRate: 0.006,
    })).toBeNull()
  })

  it('rejects malformed or unsupported quantities instead of silently turning them into zero', () => {
    expect(() => parseKubernetesQuantity('1foo')).toThrow('Unsupported Kubernetes resource quantity')
    expect(() => parseKubernetesQuantity('not-a-quantity')).toThrow('Invalid Kubernetes resource quantity')
  })
})