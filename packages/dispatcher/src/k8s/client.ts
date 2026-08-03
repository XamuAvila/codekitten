import * as k8s from "@kubernetes/client-node";
import type { V1Pod } from "@kubernetes/client-node";

/**
 * Thin wrapper around the K8s CoreV1Api for Pod lifecycle operations.
 *
 * Uses in-cluster config when running inside K8s (ServiceAccount auth),
 * falls back to kubeconfig (~/.kube/config) for local development.
 * Easy to mock in tests — all K8s calls go through this class.
 */
export class K8sClient {
  private readonly api: k8s.CoreV1Api;

  constructor(api?: k8s.CoreV1Api) {
    if (api) {
      this.api = api;
      return;
    }

    const kc = new k8s.KubeConfig();

    try {
      kc.loadFromCluster();
    } catch {
      // Fallback: local kubeconfig for dev environments
      kc.loadFromDefault();
    }

    this.api = kc.makeApiClient(k8s.CoreV1Api);
  }

  /**
   * Creates a Pod from the given manifest.
   * Throws on K8s API errors (caller should catch and wrap in AppError).
   */
  async createPod(manifest: V1Pod): Promise<V1Pod> {
    const namespace = manifest.metadata?.namespace ?? "default";
    const response = await this.api.createNamespacedPod({
      namespace,
      body: manifest,
    });
    return response;
  }

  /**
   * Deletes a Pod by name and namespace.
   * Used for cleanup on failure or when a review completes.
   */
  async deletePod(name: string, namespace: string): Promise<void> {
    await this.api.deleteNamespacedPod({ name, namespace });
  }

  /**
   * Reads a Pod by name and namespace.
   * Returns the full V1Pod object (status, metadata, spec).
   */
  async getPod(name: string, namespace: string): Promise<V1Pod> {
    const response = await this.api.readNamespacedPod({ name, namespace });
    return response;
  }
}
