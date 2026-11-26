import { describe, expect, it } from 'vitest'
import {
  classifyWarningPriority,
  countUniqueWorkloadFindings,
  enforcesNonRoot,
  getFalcoPodKeys,
  getFalcoStatus,
  getNamespaceNetworkPolicyCoverage,
  getResourceLimitGaps,
  scoreSecurityControls,
  type SecurityControl,
} from './scan'

describe('security scan calculations', () => {
  it('counts CPU and memory limit gaps independently', () => {
    expect(getResourceLimitGaps({ resources: { limits: { cpu: '500m' } } })).toEqual({ cpu: false, memory: true })
    expect(getResourceLimitGaps({ resources: { limits: { memory: '256Mi' } } })).toEqual({ cpu: true, memory: false })
  })

  it('counts unique affected containers once across different findings', () => {
    expect(countUniqueWorkloadFindings('app',
      [{ ns: 'app', pod: 'web-1', container: 'web' }, { ns: 'app', pod: 'api-1', container: 'api' }],
      [{ ns: 'app', pod: 'web-1', container: 'web' }, { ns: 'other', pod: 'web-1', container: 'web' }],
    )).toBe(2)
  })

  it('accepts inherited non-root UID and rejects UID zero or unconfigured identity', () => {
    expect(enforcesNonRoot({}, { runAsUser: 1000 })).toBe(true)
    expect(enforcesNonRoot({ runAsUser: 0 }, {})).toBe(false)
    expect(enforcesNonRoot({ runAsUser: 0 }, { runAsNonRoot: true })).toBe(false)
    expect(enforcesNonRoot({}, {})).toBe(false)
    expect(enforcesNonRoot({ runAsNonRoot: true }, {})).toBe(true)
  })

  it('reports policy presence separately from namespace-wide default deny', () => {
    const coverage = getNamespaceNetworkPolicyCoverage('app', [
      { metadata: { namespace: 'app' }, spec: { podSelector: { matchLabels: { tier: 'api' } }, policyTypes: ['Ingress'], ingress: [] } },
      { metadata: { namespace: 'other' }, spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] } },
    ])
    expect(coverage).toEqual({ hasPolicy: true, defaultDenyIngress: false, defaultDenyEgress: false })

    expect(getNamespaceNetworkPolicyCoverage('app', [
      { metadata: { namespace: 'app' }, spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] } },
    ])).toEqual({ hasPolicy: true, defaultDenyIngress: true, defaultDenyEgress: true })
  })

  it('detects Falco DaemonSets from workload metadata and counts ready pods', () => {
    const daemonSets = [
      { metadata: { name: 'falco', namespace: 'runtime' }, spec: { template: { spec: { containers: [{ image: 'falcosecurity/falco:0.40' }] } } }, status: { numberReady: 2, desiredNumberScheduled: 3 } },
      { metadata: { name: 'falcosidekick', namespace: 'runtime' }, spec: { template: { spec: { containers: [{ image: 'falcosecurity/falcosidekick:2' }] } } }, status: { numberReady: 1, desiredNumberScheduled: 1 } },
    ]
    expect(getFalcoStatus(daemonSets)).toMatchObject({ detected: true, running: true, readyPods: 2, desiredPods: 3 })
    expect(getFalcoPodKeys(daemonSets, [
      { metadata: { namespace: 'runtime', name: 'falco-1', ownerReferences: [{ kind: 'DaemonSet', name: 'falco' }] } },
      { metadata: { namespace: 'runtime', name: 'sidekick-1', ownerReferences: [{ kind: 'DaemonSet', name: 'falcosidekick' }] } },
    ])).toEqual(new Set(['runtime/falco-1']))
  })

  it('excludes unknown controls from the custom weighted score', () => {
    const controls: SecurityControl[] = [
      { id: 'SEC-01', category: 'Pod Security', name: 'One', pass: true, severity: 'high', detail: '', count: 0 },
      { id: 'SEC-02', category: 'RBAC', name: 'Two', pass: false, severity: 'low', detail: '', count: 1 },
      { id: 'SEC-03', category: 'RBAC', name: 'Three', pass: null, severity: 'critical', detail: '', count: 0 },
    ]
    expect(scoreSecurityControls(controls)).toMatchObject({ score: 75, grade: 'B', passed: 1, failed: 1, unknown: 1, assessed: 2 })
  })

  it('does not classify arbitrary warning reasons as active threats', () => {
    expect(classifyWarningPriority('SomethingNew')).toBe('unclassified')
    expect(classifyWarningPriority('FailedMount')).toBe('high')
  })
})