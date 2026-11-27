import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

/** Bones belong to each token; geometry, materials and textures belong to the cached model. */
export function cloneModelScene(source: THREE.Object3D): THREE.Object3D {
  return cloneSkinned(source);
}

/** Release only per-instance resources. Other tokens still use the cached mesh and textures. */
export function disposeModelInstance(root: THREE.Object3D) {
  const skeletons = new Set<THREE.Skeleton>();
  root.traverse(object => {
    const skeleton = (object as THREE.SkinnedMesh).skeleton;
    if (skeleton) skeletons.add(skeleton);
  });
  for (const skeleton of skeletons) skeleton.dispose();
}

/** Release cached resources once, including materials/textures shared by several meshes. */
export function disposeModelResources(roots: THREE.Object3D[]) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const skeletons = new Set<THREE.Skeleton>();
  for (const root of roots) root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value && (value as THREE.Texture).isTexture) textures.add(value as THREE.Texture);
      }
    }
    const skeleton = (object as THREE.SkinnedMesh).skeleton;
    if (skeleton) skeletons.add(skeleton);
  });
  for (const skeleton of skeletons) skeleton.dispose();
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}

export function modelFootprint(size: unknown): number {
  const number = Number(size);
  return (Number.isFinite(number) && number > 0 ? number : 1) * 50;
}

export function modelScaleFactor(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? THREE.MathUtils.clamp(number, 20, 300) / 100 : 1;
}

export function modelAngle(value: unknown): number {
  const number = Number(value);
  // Keep valid stored angles (including 360) unchanged; only reject nonfinite input.
  return Number.isFinite(number) ? number : 0;
}
