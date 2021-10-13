import Check from "../Core/Check.js";
import defaultValue from "../Core/defaultValue.js";
import defined from "../Core/defined.js";
import FeatureTable from "./FeatureTable.js";
import FeatureTexture from "./FeatureTexture.js";
import FeatureMetadata from "./FeatureMetadata.js";
import MetadataTable from "./MetadataTable.js";

/**
 * Parse the <code>EXT_mesh_features</code> glTF extension to create a
 * feature metadata object.
 *
 * @param {Object} options Object with the following properties:
 * @param {Object} options.extension The extension JSON object.
 * @param {MetadataSchema} options.schema The parsed schema.
 * @param {Object.<String, Uint8Array>} [options.bufferViews] An object mapping bufferView IDs to Uint8Array objects.
 * @param {Object.<String, Texture>} [options.textures] An object mapping texture IDs to {@link Texture} objects.
 * @return {FeatureMetadata} A feature metadata object
 * @private
 * @experimental This feature is using part of the 3D Tiles spec that is not final and is subject to change without Cesium's standard deprecation policy.
 */
export default function parseFeatureMetadata(options) {
  options = defaultValue(options, defaultValue.EMPTY_OBJECT);
  var extension = options.extension;

  // The calling code is responsible for loading the schema.
  // This keeps metadata parsing synchronous.
  var schema = options.schema;

  //>>includeStart('debug', pragmas.debug);
  Check.typeOf.object("options.extension", extension);
  Check.typeOf.object("options.schema", schema);
  //>>includeEnd('debug');

  var i;
  var featureTables = [];
  if (defined(extension.featureTables)) {
    for (i = 0; i < extension.featureTables.length; i++) {
      var featureTable = extension.featureTables[i];
      var classDefinition = schema.classes[featureTable.class];
      var metadataTable = new MetadataTable({
        count: featureTable.count,
        properties: featureTable.properties,
        class: classDefinition,
        bufferViews: options.bufferViews,
      });
      featureTables.push(
        new FeatureTable({
          id: i,
          count: featureTable.count,
          metadataTable: metadataTable,
          extras: featureTable.extras,
          extensions: featureTable.extensions,
        })
      );
    }
  }

  var featureTextures = [];
  if (defined(extension.featureTextures)) {
    for (i = 0; i < extension.featureTextures.length; i++) {
      var featureTexture = extension.featureTextures[i];
      featureTextures.push(
        new FeatureTexture({
          id: i,
          featureTexture: featureTexture,
          class: schema.classes[featureTexture.class],
          textures: options.textures,
        })
      );
    }
  }

  return new FeatureMetadata({
    schema: schema,
    featureTables: featureTables,
    featureTextures: featureTextures,
    statistics: extension.statistics,
    extras: extension.extras,
    extensions: extension.extensions,
  });
}
