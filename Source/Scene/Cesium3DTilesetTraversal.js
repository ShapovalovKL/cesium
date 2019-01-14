define([
        '../Core/defined',
        '../Core/Intersect',
        '../Core/ManagedArray',
        '../Core/Math',
        './Cesium3DTileOptimizationHint',
        './Cesium3DTileRefine'
    ], function(
        defined,
        Intersect,
        ManagedArray,
        CesiumMath,
        Cesium3DTileOptimizationHint,
        Cesium3DTileRefine) {
    'use strict';

    /**
     * @private
     */
    function Cesium3DTilesetTraversal() {
    }

    function isVisible(tile) {
        return tile._visible && tile._inRequestVolume;
    }

    var traversal = {
        stack : new ManagedArray(),
        stackMaximumLength : 0
    };

    var emptyTraversal = {
        stack : new ManagedArray(),
        stackMaximumLength : 0
    };

    var descendantTraversal = {
        stack : new ManagedArray(),
        stackMaximumLength : 0
    };

    var selectionTraversal = {
        stack : new ManagedArray(),
        stackMaximumLength : 0,
        ancestorStack : new ManagedArray(),
        ancestorStackMaximumLength : 0
    };

    var descendantSelectionDepth = 2;

    Cesium3DTilesetTraversal.selectTiles = function(tileset, frameState) {
        tileset._requestedTiles.length = 0;

        if (tileset.debugFreezeFrame) {
            return;
        }

        tileset._selectedTiles.length = 0;
        tileset._selectedTilesToStyle.length = 0;
        tileset._emptyTiles.length = 0;
        tileset._hasMixedContent = false;

        var root = tileset.root;
        updateTile(tileset, root, frameState);

        // The root tile is not visible
        if (!isVisible(root)) {
            return;
        }

        // The tileset doesn't meet the SSE requirement, therefore the tree does not need to be rendered
        if (root.getScreenSpaceError(frameState, true) <= tileset._maximumScreenSpaceError) {
            return;
        }

        tileset._heatmap.resetMinMax();

        if (!skipLevelOfDetail(tileset)) {
            executeBaseTraversal(tileset, root, frameState);
        } else if (tileset.immediatelyLoadDesiredLevelOfDetail) {
            executeSkipTraversal(tileset, root, frameState);
        } else {
            executeBaseAndSkipTraversal(tileset, root, frameState);
        }

        traversal.stack.trim(traversal.stackMaximumLength);
        emptyTraversal.stack.trim(emptyTraversal.stackMaximumLength);
        descendantTraversal.stack.trim(descendantTraversal.stackMaximumLength);
        selectionTraversal.stack.trim(selectionTraversal.stackMaximumLength);
        selectionTraversal.ancestorStack.trim(selectionTraversal.ancestorStackMaximumLength);

        return true;
    };

    function executeBaseTraversal(tileset, root, frameState) {
        var baseScreenSpaceError = tileset._maximumScreenSpaceError;
        var maximumScreenSpaceError = tileset._maximumScreenSpaceError;
        executeTraversal(tileset, root, baseScreenSpaceError, maximumScreenSpaceError, frameState);
    }

    function executeSkipTraversal(tileset, root, frameState) {
        var baseScreenSpaceError = Number.MAX_VALUE;
        var maximumScreenSpaceError = tileset._maximumScreenSpaceError;
        executeTraversal(tileset, root, baseScreenSpaceError, maximumScreenSpaceError, frameState);
        traverseAndSelect(tileset, root, frameState);
    }

    function executeBaseAndSkipTraversal(tileset, root, frameState) {
        var baseScreenSpaceError = Math.max(tileset.baseScreenSpaceError, tileset.maximumScreenSpaceError);
        var maximumScreenSpaceError = tileset.maximumScreenSpaceError;
        executeTraversal(tileset, root, baseScreenSpaceError, maximumScreenSpaceError, frameState);
        traverseAndSelect(tileset, root, frameState);
    }

    function skipLevelOfDetail(tileset) {
        return tileset._skipLevelOfDetail;
    }

    function addEmptyTile(tileset, tile) {
        tileset._emptyTiles.push(tile);
    }

    function selectTile(tileset, tile, frameState) {
        if (tile.contentVisibility(frameState) !== Intersect.OUTSIDE) {
            var tileContent = tile.content;
            if (tileContent.featurePropertiesDirty) {
                // A feature's property in this tile changed, the tile needs to be re-styled.
                tileContent.featurePropertiesDirty = false;
                tile.lastStyleTime = 0; // Force applying the style to this tile
                tileset._selectedTilesToStyle.push(tile);
            } else if ((tile._selectedFrame < frameState.frameNumber - 1)) {
                // Tile is newly selected; it is selected this frame, but was not selected last frame.
                tileset._selectedTilesToStyle.push(tile);
            }
            tile._selectedFrame = frameState.frameNumber;
            tileset._selectedTiles.push(tile);
        }
    }

    function selectDescendants(tileset, root, frameState) {
        var stack = descendantTraversal.stack;
        stack.push(root);
        while (stack.length > 0) {
            descendantTraversal.stackMaximumLength = Math.max(descendantTraversal.stackMaximumLength, stack.length);
            var tile = stack.pop();
            var children = tile.children;
            var childrenLength = children.length;
            for (var i = 0; i < childrenLength; ++i) {
                var child = children[i];
                if (isVisible(child)) {
                    if (child.contentAvailable) {
                        updateTile(tileset, child, frameState);
                        touchTile(tileset, child, frameState);
                        selectTile(tileset, child, frameState);
                    } else if (child._depth - root._depth < descendantSelectionDepth) {
                        // Continue traversing, but not too far
                        stack.push(child);
                    }
                }
            }
        }
    }

    function selectDesiredTile(tileset, tile, frameState) {
        if (!skipLevelOfDetail(tileset)) {
            if (tile.contentAvailable) {
                // The tile can be selected right away and does not require traverseAndSelect
                selectTile(tileset, tile, frameState);
            }
            return;
        }

        // If this tile is not loaded attempt to select its ancestor instead
        var loadedTile = tile.contentAvailable ? tile : tile._ancestorWithContentAvailable;
        if (defined(loadedTile)) {
            // Tiles will actually be selected in traverseAndSelect
            loadedTile._shouldSelect = true;
        } else {
            // If no ancestors are ready traverse down and select tiles to minimize empty regions.
            // This happens often for immediatelyLoadDesiredLevelOfDetail where parent tiles are not necessarily loaded before zooming out.
            selectDescendants(tileset, tile, frameState);
        }
    }

    function visitTile(tileset, tile, frameState) {
        ++tileset._statistics.visited;
        tile._visitedFrame = frameState.frameNumber;
    }

    function touchTile(tileset, tile, frameState) {
        if (tile._touchedFrame === frameState.frameNumber) {
            // Prevents another pass from touching the frame again
            return;
        }
        tileset._cache.touch(tile);
        tile._touchedFrame = frameState.frameNumber;
    }

    function getPriority(tileset, tile) {
        // If skipLevelOfDetail is off try to load child tiles as soon as possible so that their parent can refine sooner.
        // Additive tiles are prioritized by distance because it subjectively looks better.
        // Replacement tiles are prioritized by screen space error.
        // A tileset that has both additive and replacement tiles may not prioritize tiles as effectively since SSE and distance
        // are different types of values. Maybe all priorities need to be normalized to 0-1 range.
        // if (tile.refine === Cesium3DTileRefine.ADD) {
        //     return tile._distanceToCamera;
        // }
        var boundingSphere = tile._boundingVolume.boundingSphere;
        // var tileCenter = boundingSphere.center;
        // var toCenter = Cartesian3.subtract(tileCenter, frameState.camera.positionWC, scratchHeyHo);
        //
        // // ABS VAL FOR DISTANCE
        // // var camSpaceDepth = Math.abs(Cartesian3.dot(frameState.camera.directionWC, toCenter));
        // // var distanceFromCenterPlane = Math.abs(Cartesian3.dot(toCenter, frameState.camera.rightWC));
        //
        // // THINGS BEHIND SET NEGATIVE (handled by tile._priority)
        // var camSpaceDepth = Cartesian3.dot(frameState.camera.directionWC, toCenter);
        // var sign = camSpaceDepth < 0 ? -1 : 1;
        // var distanceFromCenterPlane = sign * Math.abs(Cartesian3.dot(toCenter, frameState.camera.rightWC));
        // var toCenterLength = Cartesian3.magnitude(toCenter) * sign;
        //
        // // Center Line Distance
        // var cameraSpaceDepthVec = Cartesian3.multiplyByScalar(frameState.camera.directionWC, camSpaceDepth, scratchHeyHo);
        // var cameraCenterDepthPoint = Cartesian3.add(frameState.camera.positionWC, cameraSpaceDepthVec, scratchHeyHo);
        // var centerLineToBoundCenter = Cartesian3.subtract(tileCenter, cameraCenterDepthPoint, scratchHeyHo);
        // var distanceFromCenterLine = Cartesian3.magnitude(centerLineToBoundCenter);
        // // return distanceFromCenterLine;
        //
        // var topdownViewPriority = distanceFromCenterLine;
        // var horizonViewPriority = distanceFromCenterPlane + camSpaceDepth;        // Center Plane is better metric than center line (and cheaper)
        // // return horizonViewPriority;
        // // return topdownViewPriority;
        // var interpValue = Math.abs(frameState.camera.directionWC.y);
        // // return interpValue * topdownViewPriority + (1 - interpValue) * horizonViewPriority;
        // // return horizonViewPriority;
        // // return tile._depth;
        // // return distanceFromCenterPlane;
        // // return camSpaceDepth;
        //
        // // ALREADY CALCULATED:
        // // this._distanceToCamera = this.distanceToTile(frameState);// dist to closest point on the aabb??
        // // this._centerZDepth = this.distanceToTileCenter(frameState); // camera space depth

        // BEST SO FAR:
        var priority = CesiumMath.clamp(tile._centerZDepth - boundingSphere.radius, 0, tile._centerZDepth); // Any negative z depth will get clamped to 0. If inside sphere then clamped to 0. Maybe we want to deferr negatives? we really only want closest positive? closest to 0?
        return priority;

        // if (tile._centerZDepth >= 0) {
        //     return CesiumMath.clamp(tile._centerZDepth - boundingSphere.radius, 0, tile._centerZDepth);
        // } else {
        //     return CesiumMath.clamp(tile._centerZDepth + boundingSphere.radius, tile._centerZDepth, 0);
        // }
        // return CesiumMath.clamp(toCenterLength - boundingSphere.radius, 0, toCenterLength);
        // return toCenterLength;
        // return tile._centerZDepth;
        // return tile._distanceToCamera;


        // TODO: For multi-dimensional priorities, you need some way of treating the priority like a digit
        // in a traditional number system. Higher priorities will be a higher digit than lower priorities.
        // Since each priority dimension will have a different range of values I think trying to monitor the ranges
        // of each priority so that they can be better tone mapped into 0-1 then shifted into its priority range
        // ex: if you had 3 priorities you want to sort by each with a more important priority than the other
        // then you would 0-1 tone map each then the low would stay the same at 0-1, the next highest would be 1-2
        // and the next hightest would be 2-3. If there isn't a clear boundary of importance amongst the priorities then maybe you would
        // let the boundaries bleed into one another: lowest-ish priority would be 0-2, next would be 1-3 and next would be 2-4 or something like that
        // Maybe 0-10, 10-99, 100-999 is better for the distinct levels case.


        // var parent = tile.parent;
        // var useParentScreenSpaceError = defined(parent) && (!skipLevelOfDetail(tileset) || (tile._screenSpaceError === 0.0) || parent.hasTilesetContent);
        // var screenSpaceError = useParentScreenSpaceError ? parent._screenSpaceError : tile._screenSpaceError;
        // var rootScreenSpaceError = tileset.root._screenSpaceError;
        // return rootScreenSpaceError - screenSpaceError; // Map higher SSE to lower values (e.g. root tile is highest priority)


    }


    function updateMinMaxPriority(tileset, tile) {
        tileset._maxPriority.distance = Math.max(tile._priorityDistanceHolder._priorityDistance, tileset._maxPriority.distance);
        if (tile._priorityDistance < tileset._minPriority.distance) {
            tileset._minPriority.distance = tile._priorityDistance;
            tileset._minPriority.minDistanceTile = tile;
        }
        if (tile._priorityDistanceHolder._priorityDistance <= tileset._minPriority.distance) {
            tileset._minPriority.minPriorityHolder = tile;
        }
        tileset._maxPriority.level = Math.max(tile._depth, tileset._maxPriority.level);
        tileset._minPriority.level = Math.min(tile._depth, tileset._minPriority.level);
    }

    function loadTile(tileset, tile, frameState) {
        if (hasUnloadedContent(tile) || tile.contentExpired) {
            tile._requestedFrame = frameState.frameNumber;
            updateMinMaxPriority(tileset, tile);
            tileset._requestedTiles.push(tile);
        }
    }

    function updateVisibility(tileset, tile, frameState) {
        if (tile._updatedVisibilityFrame === tileset._updatedVisibilityFrame) {
            // Return early if visibility has already been checked during the traversal.
            // The visibility may have already been checked if the cullWithChildrenBounds optimization is used.
            return;
        }

        tile.updateVisibility(frameState);
        tile._updatedVisibilityFrame = tileset._updatedVisibilityFrame;
    }

    function anyChildrenVisible(tileset, tile, frameState) {
        var anyVisible = false;
        var children = tile.children;
        var length = children.length;
        for (var i = 0; i < length; ++i) {
            var child = children[i];
            updateVisibility(tileset, child, frameState);
            anyVisible = anyVisible || isVisible(child);
        }
        return anyVisible;
    }

    function meetsScreenSpaceErrorEarly(tileset, tile, frameState) {
        var parent = tile.parent;
        if (!defined(parent) || parent.hasTilesetContent || (parent.refine !== Cesium3DTileRefine.ADD)) {
            return false;
        }

        // Use parent's geometric error with child's box to see if the tile already meet the SSE
        return tile.getScreenSpaceError(frameState, true) <= tileset._maximumScreenSpaceError;
    }

    function updateTileVisibility(tileset, tile, frameState) {
        updateVisibility(tileset, tile, frameState);

        if (!isVisible(tile)) {
            return;
        }

        var hasChildren = tile.children.length > 0;
        if (tile.hasTilesetContent && hasChildren) {
            // Use the root tile's visibility instead of this tile's visibility.
            // The root tile may be culled by the children bounds optimization in which
            // case this tile should also be culled.
            var child = tile.children[0];
            updateTileVisibility(tileset, child, frameState);
            tile._visible = child._visible;
            return;
        }

        if (meetsScreenSpaceErrorEarly(tileset, tile, frameState)) {
            tile._visible = false;
            return;
        }

        // Optimization - if none of the tile's children are visible then this tile isn't visible
        var replace = tile.refine === Cesium3DTileRefine.REPLACE;
        var useOptimization = tile._optimChildrenWithinParent === Cesium3DTileOptimizationHint.USE_OPTIMIZATION;
        if (replace && useOptimization && hasChildren) {
            if (!anyChildrenVisible(tileset, tile, frameState)) {
                ++tileset._statistics.numberOfTilesCulledWithChildrenUnion;
                tile._visible = false;
                return;
            }
        }
    }

    function updateTile(tileset, tile, frameState) {
        // Reset some of the tile's flags to neutral and re-evaluate visability, and ancestor content pointers
        tile.updateVisibility(frameState);
        tile._priorityDistance = getPriority(tileset, tile, frameState); // updateAndPushChildren() needs this value for the priority chaining so it must be determined here and not loadTile
        tile._priorityDistanceHolder = tile;
        // updateMinMaxPriority(tileset, tile);
        tile.updateExpiration();

        // Alpha blending
        tile._decendantsThatHaveFadedIn = 0;
        tile._decendantsThatHaveFadedInLastFrame = 0;
        tile._decendantsCount = 0;

        // Priority scheme
        tile._wasMinChild = false;

        // SkipLOD
        tile._shouldSelect = false;
        tile._finalResolution = true;
    }

    function updateTileAncestorContentLinks(tile, frameState) {
        tile._ancestorWithContent = undefined;
        tile._ancestorWithContentAvailable = undefined;

        var parent = tile.parent;
        if (defined(parent)) {
            var hasContent = !hasUnloadedContent(parent) || (parent._requestedFrame === frameState.frameNumber);
            tile._ancestorWithContent = hasContent ? parent : parent._ancestorWithContent;
            tile._ancestorWithContentAvailable = parent.contentAvailable ? parent : parent._ancestorWithContentAvailable; // Links a decendent up to its contentAvailable ancestor as the traversal progresses.
        }
    }


    // function updateTile(tileset, tile, frameState) {
    //     updateTileVisibility(tileset, tile, frameState);
    //     tile.updateExpiration();
    //
    //     tile._shouldSelect = false;
    //     tile._finalResolution = true;
    //     tile._ancestorWithContent = undefined;
    //     tile._ancestorWithContentAvailable = undefined;
    //
    //     var parent = tile.parent;
    //     if (defined(parent)) {
    //         // ancestorWithContent is an ancestor that has content or has the potential to have
    //         // content. Used in conjunction with tileset.skipLevels to know when to skip a tile.
    //         // ancestorWithContentAvailable is an ancestor that is rendered if a desired tile is not loaded.
    //         var hasContent = !hasUnloadedContent(parent) || (parent._requestedFrame === frameState.frameNumber);
    //         tile._ancestorWithContent = hasContent ? parent : parent._ancestorWithContent;
    //         tile._ancestorWithContentAvailable = parent.contentAvailable ? parent : parent._ancestorWithContentAvailable;
    //     }
    // }

    function hasEmptyContent(tile) {
        return tile.hasEmptyContent || tile.hasTilesetContent;
    }

    function hasUnloadedContent(tile) {
        return !hasEmptyContent(tile) && tile.contentUnloaded;
    }

    function reachedSkippingThreshold(tileset, tile) {
        var ancestor = tile._ancestorWithContent;
        return !tileset.immediatelyLoadDesiredLevelOfDetail &&
               defined(ancestor) &&
               (tile._screenSpaceError < (ancestor._screenSpaceError / tileset.skipScreenSpaceErrorFactor)) &&
               (tile._depth > (ancestor._depth + tileset.skipLevels));
    }

    function sortChildrenByDistanceToCamera(a, b) {
        // Sort by farthest child first since this is going on a stack
        if (b._distanceToCamera === 0 && a._distanceToCamera === 0) {
            return b._centerZDepth - a._centerZDepth;
        }

        return b._distanceToCamera - a._distanceToCamera;
    }

    function updateAndPushChildren(tileset, tile, stack, frameState) {
        var i;
        var replace = tile.refine === Cesium3DTileRefine.REPLACE;
        var children = tile.children;
        var length = children.length;

        for (i = 0; i < length; ++i) {
            updateTile(tileset, children[i], frameState);
        }

        // Sort by distance to take advantage of early Z and reduce artifacts for skipLevelOfDetail
        children.sort(sortChildrenByDistanceToCamera);

        // For traditional replacement refinement only refine if all children are loaded.
        // Empty tiles are exempt since it looks better if children stream in as they are loaded to fill the empty space.
        var checkRefines = !skipLevelOfDetail(tileset) && replace && !hasEmptyContent(tile);
        var refines = true;
        var anyChildrenVisible = false;

        // _wasMinChild
        var minIndex = -1;
        var minDistancePriority = Number.MAX_VALUE;

        for (i = 0; i < length; ++i) {
            var child = children[i];
            if (isVisible(child)) {
                stack.push(child);
                if (child._priorityDistance < minDistancePriority) {
                    minIndex = i;
                    minDistancePriority = child._priorityDistance;
                }
                anyChildrenVisible = true;
            } else if (checkRefines || tileset.loadSiblings) {
                // Keep non-visible children loaded since they are still needed before the parent can refine.
                // Or loadSiblings is true so always load tiles regardless of visibility.
                if (child._priorityDistance < minDistancePriority) {
                    minIndex = i;
                    minDistancePriority = child._priorityDistance;
                }
                loadTile(tileset, child, frameState);
                touchTile(tileset, child, frameState);
            }
            if (checkRefines) {
                var childRefines;
                if (!child._inRequestVolume) {
                    childRefines = false;
                } else if (hasEmptyContent(child)) {
                    childRefines = executeEmptyTraversal(tileset, child, frameState);
                } else {
                    childRefines = child.contentAvailable;
                }
                refines = refines && childRefines;
            }
        }

        if (!anyChildrenVisible) {
            refines = false;
        }

        // For the priority scheme, priorites are inherited up the tree as needed.       
        // Only link up if the tile hasn't already been linked to something else (this will be the case if the tile is the root or the closest child tile amongst its siblings in a previous updateAndPushChildren)
        // Need siblings to link their minPriority their siblings to help refinement along, otherwise it will get held up the renfinement dependencies will be out of sync priority wise (important for non-skipLOD in general and important for skipLOD to remove higher lod artifacts as fast as possible (giant triangles cutting through the near parts of the scene) helps alpha blending look nicer)
        if (minIndex !== -1) {
            var minPriorityChild = children[minIndex];
            minPriorityChild._wasMinChild = true;
            var priorityHolder = tile._wasMinChild || tile === tileset.root ? tile._priorityDistanceHolder : tile; // This is where priority dependencies chains are wired up and existing one or started anew.
            priorityHolder._priorityDistance = minPriorityChild._priorityDistance;

            for (i = 0; i < length; ++i) {
                var child = children[i];
                child._priorityDistanceHolder = priorityHolder;
            }
        }

        return refines;
    }

    function inBaseTraversal(tileset, tile, baseScreenSpaceError) {
        if (!skipLevelOfDetail(tileset)) {
            return true;
        }
        if (tileset.immediatelyLoadDesiredLevelOfDetail) {
            return false;
        }
        if (!defined(tile._ancestorWithContent)) {
            // Include root or near-root tiles in the base traversal so there is something to select up to
            return true;
        }
        if (tile._screenSpaceError === 0.0) {
            // If a leaf, use parent's SSE
            return tile.parent._screenSpaceError > baseScreenSpaceError;
        }
        return tile._screenSpaceError > baseScreenSpaceError;
    }

    function canTraverse(tileset, tile) {
        if (tile.children.length === 0) {
            return false;
        }
        if (tile.hasTilesetContent) {
            // Traverse external tileset to visit its root tile
            // Don't traverse if the subtree is expired because it will be destroyed
            return !tile.contentExpired;
        }
        return tile._screenSpaceError > tileset._maximumScreenSpaceError;
    }

    function executeTraversal(tileset, root, baseScreenSpaceError, maximumScreenSpaceError, frameState) {
        // Depth-first traversal that traverses all visible tiles and marks tiles for selection.
        // If skipLevelOfDetail is off then a tile does not refine until all children are loaded.
        // This is the traditional replacement refinement approach and is called the base traversal.
        // Tiles that have a greater screen space error than the base screen space error are part of the base traversal,
        // all other tiles are part of the skip traversal. The skip traversal allows for skipping levels of the tree
        // and rendering children and parent tiles simultaneously.
        var stack = traversal.stack;
        stack.push(root);

        while (stack.length > 0) {
            traversal.stackMaximumLength = Math.max(traversal.stackMaximumLength, stack.length);

            var tile = stack.pop();

            updateTileAncestorContentLinks(tile, frameState);
            var baseTraversal = inBaseTraversal(tileset, tile, baseScreenSpaceError);
            var add = tile.refine === Cesium3DTileRefine.ADD;
            var replace = tile.refine === Cesium3DTileRefine.REPLACE;
            var parent = tile.parent;
            var parentRefines = !defined(parent) || parent._refines;
            var refines = false;

            if (canTraverse(tileset, tile)) {
                refines = updateAndPushChildren(tileset, tile, stack, frameState) && parentRefines;
            }

            var stoppedRefining = !refines && parentRefines;

            if (hasEmptyContent(tile)) {
                // Add empty tile just to show its debug bounding volume
                // If the tile has tileset content load the external tileset
                // If the tile cannot refine further select its nearest loaded ancestor
                addEmptyTile(tileset, tile, frameState);
                loadTile(tileset, tile, frameState);
                if (stoppedRefining) {
                    selectDesiredTile(tileset, tile, frameState);
                }
            } else if (add) {
                // Additive tiles are always loaded and selected
                selectDesiredTile(tileset, tile, frameState);
                loadTile(tileset, tile, frameState);
            } else if (replace) {
                if (baseTraversal) {
                    // Always load tiles in the base traversal
                    // Select tiles that can't refine further
                    loadTile(tileset, tile, frameState);
                    if (stoppedRefining) {
                        selectDesiredTile(tileset, tile, frameState);
                    }
                } else if (stoppedRefining) {
                    // In skip traversal, load and select tiles that can't refine further
                    selectDesiredTile(tileset, tile, frameState);
                    loadTile(tileset, tile, frameState);
                } else if (reachedSkippingThreshold(tileset, tile)) {
                    // In skip traversal, load tiles that aren't skipped. In practice roughly half the tiles stay unloaded.
                    loadTile(tileset, tile, frameState);
                }
            }

            visitTile(tileset, tile, frameState);
            touchTile(tileset, tile, frameState);
            tile._refines = refines;
        }
    }

    function executeEmptyTraversal(tileset, root, frameState) {
        // Depth-first traversal that checks if all nearest descendants with content are loaded. Ignores visibility.
        var allDescendantsLoaded = true;
        var stack = emptyTraversal.stack;
        stack.push(root);

        while (stack.length > 0) {
            emptyTraversal.stackMaximumLength = Math.max(emptyTraversal.stackMaximumLength, stack.length);

            var tile = stack.pop();
            var children = tile.children;
            var childrenLength = children.length;

            // Only traverse if the tile is empty - traversal stop at descendants with content
            var traverse = hasEmptyContent(tile) && canTraverse(tileset, tile);

            // Traversal stops but the tile does not have content yet.
            // There will be holes if the parent tries to refine to its children, so don't refine.
            if (!traverse && !tile.contentAvailable) {
                allDescendantsLoaded = false;
            }

            updateTile(tileset, tile, frameState);
            if (!isVisible(tile)) {
                // Load tiles that aren't visible since they are still needed for the parent to refine
                loadTile(tileset, tile, frameState);
                touchTile(tileset, tile, frameState);
            }

            if (traverse) {
                for (var i = 0; i < childrenLength; ++i) {
                    var child = children[i];
                    stack.push(child);
                }
            }
        }

        return allDescendantsLoaded;
    }

    /**
     * Traverse the tree and check if their selected frame is the current frame. If so, add it to a selection queue.
     * This is a preorder traversal so children tiles are selected before ancestor tiles.
     *
     * The reason for the preorder traversal is so that tiles can easily be marked with their
     * selection depth. A tile's _selectionDepth is its depth in the tree where all non-selected tiles are removed.
     * This property is important for use in the stencil test because we want to render deeper tiles on top of their
     * ancestors. If a tileset is very deep, the depth is unlikely to fit into the stencil buffer.
     *
     * We want to select children before their ancestors because there is no guarantee on the relationship between
     * the children's z-depth and the ancestor's z-depth. We cannot rely on Z because we want the child to appear on top
     * of ancestor regardless of true depth. The stencil tests used require children to be drawn first.
     *
     * NOTE: 3D Tiles uses 3 bits from the stencil buffer meaning this will not work when there is a chain of
     * selected tiles that is deeper than 7. This is not very likely.
     */
    function traverseAndSelect(tileset, root, frameState) {
        var stack = selectionTraversal.stack;
        var ancestorStack = selectionTraversal.ancestorStack;
        var lastAncestor;

        stack.push(root);

        while (stack.length > 0 || ancestorStack.length > 0) {
            selectionTraversal.stackMaximumLength = Math.max(selectionTraversal.stackMaximumLength, stack.length);
            selectionTraversal.ancestorStackMaximumLength = Math.max(selectionTraversal.ancestorStackMaximumLength, ancestorStack.length);

            if (ancestorStack.length > 0) {
                var waitingTile = ancestorStack.peek();
                if (waitingTile._stackLength === stack.length) {
                    ancestorStack.pop();
                    if (waitingTile !== lastAncestor) {
                        waitingTile._finalResolution = false;
                    }
                    selectTile(tileset, waitingTile, frameState);
                    continue;
                }
            }

            var tile = stack.pop();
            if (!defined(tile)) {
                // stack is empty but ancestorStack isn't
                continue;
            }

            var add = tile.refine === Cesium3DTileRefine.ADD;
            var shouldSelect = tile._shouldSelect;
            var children = tile.children;
            var childrenLength = children.length;
            var traverse = canTraverse(tileset, tile);

            if (shouldSelect) {
                if (add) {
                    selectTile(tileset, tile, frameState);
                } else {
                    tile._selectionDepth = ancestorStack.length;
                    if (tile._selectionDepth > 0) {
                        tileset._hasMixedContent = true;
                    }
                    lastAncestor = tile;
                    if (!traverse) {
                        selectTile(tileset, tile, frameState);
                        continue;
                    }
                    ancestorStack.push(tile);
                    tile._stackLength = stack.length;
                }
            }

            if (traverse) {
                for (var i = 0; i < childrenLength; ++i) {
                    var child = children[i];
                    if (isVisible(child)) {
                        stack.push(child);
                    }
                }
            }
        }
    }

    return Cesium3DTilesetTraversal;
});
