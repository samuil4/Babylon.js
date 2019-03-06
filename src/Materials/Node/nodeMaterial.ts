import { NodeMaterialBlock } from './nodeMaterialBlock';
import { Material } from '../material';
import { Scene } from '../../scene';
import { AbstractMesh } from '../../Meshes/abstractMesh';
import { Matrix } from '../../Maths/math';
import { Mesh } from '../../Meshes/mesh';
import { Engine } from '../../Engines/engine';
import { NodeMaterialCompilationState } from './nodeMaterialCompilationState';
import { EffectCreationOptions } from '../effect';
import { BaseTexture } from '../../Materials/Textures/baseTexture';
import { NodeMaterialConnectionPoint } from './nodeMaterialBlockConnectionPoint';
import { NodeMaterialBlockConnectionPointTypes } from './nodeMaterialBlockConnectionPointTypes';

export interface INodeMaterialOptions {
    needAlphaBlending: boolean,
    needAlphaTesting: boolean
}

export class NodeMaterial extends Material {
    private _options: INodeMaterialOptions;
    private _vertexCompilationState: NodeMaterialCompilationState;
    private _fragmentCompilationState: NodeMaterialCompilationState;
    private _compileId: number = 0;
    private _renderId: number;
    private _effectCompileId: number = 0;
    private _cachedWorldViewMatrix = new Matrix();
    private _cachedWorldViewProjectionMatrix = new Matrix();
    private _textureConnectionPoints = new Array<NodeMaterialConnectionPoint>()

    /**
     * Gets or sets the root node of the material vertex shader
     */
    public vertexRootNode: NodeMaterialBlock;

    /**
     * Gets or sets the root node of the material fragment (pixel) shader
     */
    public fragmentRootNode: NodeMaterialBlock;

    /** Gets or sets options to control the node material overall behavior */
    public get options() {
        return this._options;
    }

    public set options(options: INodeMaterialOptions) {
        this._options = options;
    }

    constructor(name: string, scene?: Scene, options: Partial<INodeMaterialOptions> = {}) {
        super(name, scene || Engine.LastCreatedScene!);

        this._options = {
            needAlphaBlending: false,
            needAlphaTesting: false,
            ...options
        };
    }

    /**
     * Gets the current class name of the material e.g. "NodeMaterial"
     * @returns the class name
     */
    public getClassName(): string {
        return "NodeMaterial";
    }

    /**
     * Compile the material and generates the inner effect
     */
    public compile() {
        if (!this.vertexRootNode) {
            throw "You must define a vertexRootNode";
        }

        if (!this.fragmentRootNode) {
            throw "You must define a fragmentRootNode";
        }

        // Go through the nodes and do some magic :)
        // Needs to create the code and deduce samplers and uniforms in order to populate some lists used during bindings

        // Vertex
        this._vertexCompilationState = new NodeMaterialCompilationState();

        this.vertexRootNode.compile(this._vertexCompilationState);
        this.vertexRootNode.compileChildren(this._vertexCompilationState);

        // Fragment
        this._fragmentCompilationState = new NodeMaterialCompilationState();
        this._fragmentCompilationState.isInFragmentMode = true;
        this._fragmentCompilationState.vertexState = this._vertexCompilationState;
        this._fragmentCompilationState.hints = this._vertexCompilationState.hints;
        this._fragmentCompilationState.uniformConnectionPoints = this._vertexCompilationState.uniformConnectionPoints;

        this.fragmentRootNode.compile(this._fragmentCompilationState);
        this.fragmentRootNode.compileChildren(this._fragmentCompilationState);

        // Finalize
        this._vertexCompilationState.varyings = this._fragmentCompilationState.varyings;
        this._vertexCompilationState.finalize();
        this._fragmentCompilationState.finalize();

        // Textures
        this._textureConnectionPoints = this._fragmentCompilationState.uniformConnectionPoints.filter(u => u.type === NodeMaterialBlockConnectionPointTypes.Texture);

        this._compileId++;
    }

    /**
     * Checks if the material is ready to render the requested mesh
     * @param mesh defines the mesh to render
     * @param useInstances defines whether or not the material is used with instances
     * @returns true if ready, otherwise false
     */
    public isReady(mesh?: AbstractMesh, useInstances?: boolean): boolean {
        var scene = this.getScene();
        var engine = scene.getEngine();

        if (!this.checkReadyOnEveryCall) {
            if (this._renderId === scene.getRenderId()) {
                return true;
            }
        }

        // Textures
        for (var connectionPoint of this._textureConnectionPoints) {
            let texture = connectionPoint.value as BaseTexture;
            if (texture && !texture.isReady()) {
                return false;
            }
        }

        this._renderId = scene.getRenderId();

        if (this._effectCompileId === this._compileId) {
            return true;
        }

        var previousEffect = this._effect;

        // Uniforms
        let mergedUniforms = this._vertexCompilationState.uniforms;

        this._fragmentCompilationState.uniforms.forEach(u => {
            let index = mergedUniforms.indexOf(u);

            if (index === -1) {
                mergedUniforms.push(u);
            }

        });

        // Samplers
        let mergedSamplers = this._vertexCompilationState.samplers;

        this._fragmentCompilationState.samplers.forEach(s => {
            let index = mergedSamplers.indexOf(s);

            if (index === -1) {
                mergedSamplers.push(s);
            }

        });

        // Compilation
        this._effect = engine.createEffect({
            vertex: "nodeMaterial" + this._compileId,
            fragment: "nodeMaterial" + this._compileId,
            vertexSource: this._vertexCompilationState.compilationString,
            fragmentSource: this._fragmentCompilationState.compilationString
        }, <EffectCreationOptions>{
            attributes: this._vertexCompilationState.attributes,
            uniformsNames: mergedUniforms,
            samplers: this._fragmentCompilationState.samplers,
            defines: "",
            onCompiled: this.onCompiled,
            onError: this.onError
        }, engine);

        if (!this._effect.isReady()) {
            return false;
        }

        if (previousEffect !== this._effect) {
            scene.resetCachedMaterial();
        }

        this._effectCompileId = this._compileId;

        return true;
    }

    /**
     * Binds the world matrix to the material
     * @param world defines the world transformation matrix
     */
    public bindOnlyWorldMatrix(world: Matrix): void {
        var scene = this.getScene();

        if (!this._effect) {
            return;
        }

        let hints = this._fragmentCompilationState.hints;
        if (hints.needWorldMatrix) {
            this._effect.setMatrix("world", world);
        }

        if (hints.needWorldViewMatrix) {
            world.multiplyToRef(scene.getViewMatrix(), this._cachedWorldViewMatrix);
            this._effect.setMatrix("worldView", this._cachedWorldViewMatrix);
        }

        if (hints.needWorldViewProjectionMatrix) {
            world.multiplyToRef(scene.getTransformMatrix(), this._cachedWorldViewProjectionMatrix)
            this._effect.setMatrix("worldViewProjection", this._cachedWorldViewProjectionMatrix);
        }
    }

    /**
     * Binds the material to the mesh
     * @param world defines the world transformation matrix
     * @param mesh defines the mesh to bind the material to
     */
    public bind(world: Matrix, mesh?: Mesh): void {
        // Std values
        this.bindOnlyWorldMatrix(world);

        if (this._effect && this.getScene().getCachedMaterial() !== this) {
            let hints = this._fragmentCompilationState.hints;

            if (hints.needViewMatrix) {
                this._effect.setMatrix("view", this.getScene().getViewMatrix());
            }

            if (hints.needProjectionMatrix) {
                this._effect.setMatrix("projection", this.getScene().getProjectionMatrix());
            }

            if (hints.needViewProjectionMatrix) {
                this._effect.setMatrix("viewProjection", this.getScene().getTransformMatrix());
            }

            for (var connectionPoint of this._fragmentCompilationState.uniformConnectionPoints) {
                connectionPoint.transmit(this._effect);
            }
        }

        this._afterBind(mesh);
    }


    /**
     * Gets the active textures from the material
     * @returns an array of textures
     */
    public getActiveTextures(): BaseTexture[] {
        var activeTextures = super.getActiveTextures();

        for (var connectionPoint of this._textureConnectionPoints) {
            if (connectionPoint.value) {
                activeTextures.push(connectionPoint.value);
            }
        }

        return activeTextures;
    }

    /**
     * Specifies if the material uses a texture
     * @param texture defines the texture to check against the material
     * @returns a boolean specifying if the material uses the texture
     */
    public hasTexture(texture: BaseTexture): boolean {
        if (super.hasTexture(texture)) {
            return true;
        }

        for (var connectionPoint of this._textureConnectionPoints) {
            if (connectionPoint.value === texture) {
                return true;
            }
        }

        return false;
    }
}