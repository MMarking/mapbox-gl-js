// @flow

import {
    bindAll,
    extend,
    deepEqual,
    warnOnce,
    clamp,
    wrap,
    ease as defaultEasing
} from '../util/util';
import { number as interpolate } from '../style-spec/util/interpolate';
import browser from '../util/browser';
import LngLat from '../geo/lng_lat';
import LngLatBounds from '../geo/lng_lat_bounds';
import Point from '@mapbox/point-geometry';
import { Event, Evented } from '../util/evented';

import type Transform from '../geo/transform';
import type {LngLatLike} from '../geo/lng_lat';
import type {LngLatBoundsLike} from '../geo/lng_lat_bounds';
import type {TaskID} from '../util/task_queue';
import type {PointLike} from '@mapbox/point-geometry';

/**
 * 照相机的常用选项，用于 {@link Map#jumpTo}, {@link Map#easeTo}, 和 {@link Map#flyTo} 。
 * 控制摄像机的期望位置、变焦、方位和俯仰角。
 * 属性都是可选的。 当省略某个属性时，该属性的当前相机设置会保持不变。
 *
 * @typedef {Object} CameraOptions
 * @property {LngLatLike} center 设置的中心点
 * @property {number} zoom 设置的变焦级别
 * @property {number} bearing 设置的方位，单位是角度。指针方位是朝上的指南针方向。
 * 例如，指向 90° 方位，表明地图上方是东部。
 * @property {number} pitch 设置的俯仰角。单位是角度。
 * @property {LngLatLike} around 设置了变焦级别，则 `around` 决定了焦点的周围点。
 */
export type CameraOptions = {
    center?: LngLatLike,
    zoom?: number,
    bearing?: number,
    pitch?: number,
    around?: LngLatLike
};

/**
 *  地图移动方法的常用选项， {@link Map#panBy} 、{@link Map#easeTo} 等方法有用到，控制动画的持续时间、动画的缓动函数。
 * 属性都是可选的。
 *
 * @typedef {Object} AnimationOptions
 * @property {number} duration 动画的持续时间，单位是毫秒
 * @property {Function} easing 缓动函数。函数的参数是时间值，值在0到1之间。
 * 返回一个数字，其中0是初始状态，1是最终状态。
 * @property {PointLike} offset 动画结束时，目标中心点相对实际地图容器中心点的偏移量
 * @property {boolean} animate 如果设置否，就不会出现动画。
 */
export type AnimationOptions = {
    duration?: number,
    easing?: (number) => number,
    offset?: PointLike,
    animate?: boolean
};

/**
 * 设置内边距的选项，调用 {@link Map#fitBounds} 用到。
 * 该对象的属性都必须是非负整数。
 *
 * @typedef {Object} PaddingOptions
 * @property {number} top 地图画布的上内边距，单位是像素
 * @property {number} bottom 地图画布的下内边距，单位是像素
 * @property {number} left 地图画布的左内边距，单位是像素
 * @property {number} right 地图画布的右内边距，单位是像素
 */

class Camera extends Evented {
    transform: Transform;
    _moving: boolean;
    _zooming: boolean;
    _rotating: boolean;
    _pitching: boolean;

    _bearingSnap: number;
    _easeEndTimeoutID: TimeoutID;
    _easeStart: number;
    _easeOptions: {duration: number, easing: (number) => number};

    _onEaseFrame: (number) => void;
    _onEaseEnd: () => void;
    _easeFrameId: ?TaskID;

    +_requestRenderFrame: (() => void) => TaskID;
    +_cancelRenderFrame: (TaskID) => void;

    constructor(transform: Transform, options: {bearingSnap: number}) {
        super();
        this._moving = false;
        this._zooming = false;
        this.transform = transform;
        this._bearingSnap = options.bearingSnap;

        bindAll(['_renderFrameCallback'], this);
    }
    /**
     * 返回地图的地理中心点。
     *
     * @memberof Map#
     * @returns 地图的地理中心点。
     */
    getCenter(): LngLat { return this.transform.center; }

    /**
     * 设置地图的地理中心点。相当于`jumpTo（{center：center}）`。
     *
     * @memberof Map＃
     * @param center 要设置的中心点。
     * @param eventData 要添加到此方法触发的事件的事件对象的其他属性。
     * @fires movestart
     * @fires moveend
     * @returns {Map}`this`
     * @example
     * map.setCenter（[ -  74,38]）;
     */
    setCenter(center: LngLatLike, eventData?: Object) {
        return this.jumpTo({center: center}, eventData);
    }

    /**
     * 按照指定的地图平移地图。
     *
     * @memberof Map＃
     * @param offset `x`和`y`坐标用于平移地图。
     * @param options
     * @param eventData 要添加到此方法触发的事件的事件对象的其他属性。
     * @fires movestart
     * @fires moveend
     * @returns {Map}`this`
     * @see [Navigate the map with game-like controls]（https://www.mapbox.com/mapbox-gl-js/example/game-controls/）
     */
    panBy(offset: PointLike, options?: AnimationOptions, eventData?: Object) {
        offset = Point.convert(offset).mult(-1);
        return this.panTo(this.transform.center, extend({offset}, options), eventData);
    }

    /**
     * 使用动画过渡将地图平移到指定位置。
     *
     * @memberof Map＃
     * @param lnglat 将地图平移到的位置。
     * @param选项
     * @param eventData 要添加到此方法触发的事件的事件对象的其他属性。
     * @fires movestart
     * @fires moveend
     * @returns {Map}`this`
     */
    panTo(lnglat: LngLatLike, options?: AnimationOptions, eventData?: Object) {
        return this.easeTo(extend({
            center: lnglat
        }, options), eventData);
    }
    /**
     * 返回地图当前的缩放等级。
     *
     * @memberof Map#
     * @returns 地图目前的缩放等级。
     */
    getZoom(): number { return this.transform.zoom; }

    /**
     * 设置地图的缩放等级。相当于`jumpTo({zoom: zoom})`。
     *
     * @memberof Map#
     * @param zoom (0-20)的缩放等级.
     * @param eventData 要添加到此方法触发的事件的事件对象的其他属性。
     * @fires movestart
     * @fires zoomstart
     * @fires move
     * @fires zoom
     * @fires moveend
     * @fires zoomend
     * @returns {Map} `this`
     * @example
     * // 缩放地图到等级
     * map.setZoom(5);
     */
    setZoom(zoom: number, eventData?: Object) {
        this.jumpTo({zoom: zoom}, eventData);
        return this;
    }
     /**
     * 使用动画过渡将地图缩放到指定的缩放级别。
     *
     * @memberof Map#
     * @param zoom 要转换到的缩放级别。
     * @param options
     * @param eventData 要添加到此方法触发的事件的事件对象的其他属性。
     * @fires movestart
     * @fires zoomstart
     * @fires move
     * @fires zoom
     * @fires moveend
     * @fires zoomend
     * @returns {Map} `this`
     */
    zoomTo(zoom: number, options: ? AnimationOptions, eventData?: Object) {
        return this.easeTo(extend({
            zoom: zoom
        }, options), eventData);
    }

    /**
     * 增加一个等级的地图缩放程度
     *
     * @memberof Map#
     * @param options
     * @param eventData 要添加到此方法触发的事件的事件对象的其他属性。
     * @fires movestart
     * @fires zoomstart
     * @fires move
     * @fires zoom
     * @fires moveend
     * @fires zoomend
     * @returns {Map} `this`
     */
    zoomIn(options?: AnimationOptions, eventData?: Object) {
        this.zoomTo(this.getZoom() + 1, options, eventData);
        return this;
    }

    /**
     * 减少地图的一个缩放等级。
     *
     * @memberof Map#
     * @param options
     * @param eventData 要添加到此方法触发的事件的事件对象的其他属性。
     * @fires movestart
     * @fires zoomstart
     * @fires move
     * @fires zoom
     * @fires moveend
     * @fires zoomend
     * @returns {Map} `this`
     */
    zoomOut(options?: AnimationOptions, eventData?: Object) {
        this.zoomTo(this.getZoom() - 1, options, eventData);
        return this;
    }

    /**
     *返回地图的当前方位。轴承是罗盘方向“向上”；例如，一个轴向90°定位地图以使东向上。
     *
     * @memberof Map＃
     * @returns 地图的当前方位。
     * @see [Navigate the map with game-like controls]（https://www.mapbox.com/mapbox-gl-js/example/game-controls/）
     */
    getBearing(): number { return this.transform.bearing; }

    /**
     * 设置地图的方位（旋转）。轴承是罗盘方向“向上”；例如，一个轴向90°定位地图以使东向上。
     *
     * 相当于`jumpTo（{bearing：bearing}）`。
     *
     * @memberof Map＃
     * @param bearing 所需的方位。
     * @param eventData 要添加到此方法触发的事件的事件对象的其他属性。
     * @fires movestart
     * @fires moveend
     * @returns {Map}`this`
     * @example
     * //将地图旋转到90度
     * map.setBearing（90）;
     */
    setBearing(bearing: number, eventData?: Object) {
        this.jumpTo({bearing: bearing}, eventData);
        return this;
    }

    /**
     * 使用动画过渡将地图旋转到指定的方位。方位是罗盘方向即“向上”；例如，90°的方位使地图定向，以便东向上。
     *
     * @memberof Map＃
     * @param bearing 所需的轴向角。
     * @param options
     * @param eventData 要添加到此方法触发的事件的事件对象的其他属性。
     * @fires movestart
     * @fires moveend
     * @returns {Map}`this`
     */
    rotateTo(bearing: number, options?: AnimationOptions, eventData?: Object) {
        return this.easeTo(extend({
            bearing: bearing
        }, options), eventData);
    }

    /**
     * 旋转地图以使北向上（0°方位），并带有动画过渡。
     *
     * @memberof Map＃
     * @param options
     * @param eventData 要添加到此方法触发的事件的事件对象的其他属性。
     * @fires movestart
     * @fires moveend
     * @returns {Map}`this`
     */
    resetNorth(options?: AnimationOptions, eventData?: Object) {
        this.rotateTo(0, extend({duration: 1000}, options), eventData);
        return this;
    }

    /**     
     * 如果当前方位足够接近（在bearingSnap` 的阈值），则将地图捕捉到北向上（0°方位）
     *
     * @memberof Map＃
     * @param options
     * @param eventData 要添加到此方法触发的事件的事件对象的其他属性。
     * @fires movestart
     * @fires moveend
     * @returns {Map}`this`
     */
    snapToNorth(options?: AnimationOptions, eventData?: Object) {
        if (Math.abs(this.getBearing()) < this._bearingSnap) {
            return this.resetNorth(options, eventData);
        }
        return this;
    }

    /**
     * 返回地图当前的轴向角（倾斜度）。
     *
     * @memberof Map#
     * @returns 地图的当前轴向角，以度数为单位，远离屏幕表面。
     */
    getPitch(): number { return this.transform.pitch; }

    /**
     * Sets the map's pitch (tilt). Equivalent to `jumpTo({pitch: pitch})`.
     *
     * @memberof Map#
     * @param pitch The pitch to set, measured in degrees away from the plane of the screen (0-60).
     * @param eventData Additional properties to be added to event objects of events triggered by this method.
     * @fires pitchstart
     * @fires movestart
     * @fires moveend
     * @returns {Map} `this`
     */
    setPitch(pitch: number, eventData?: Object) {
        this.jumpTo({pitch: pitch}, eventData);
        return this;
    }

    /**
     * @memberof Map#
     * @param bounds Calculate the center for these bounds in the viewport and use
     *      the highest zoom level up to and including `Map#getMaxZoom()` that fits
     *      in the viewport.
     * @param options
     * @param {number | PaddingOptions} [options.padding] The amount of padding in pixels to add to the given bounds.
     * @param {PointLike} [options.offset=[0, 0]] The center of the given bounds relative to the map's center, measured in pixels.
     * @param {number} [options.maxZoom] The maximum zoom level to allow when the camera would transition to the specified bounds.
     * @returns {CameraOptions | void} If map is able to fit to provided bounds, returns `CameraOptions` with
     *      at least `center`, `zoom`, `bearing`, `offset`, `padding`, and `maxZoom`, as well as any other
     *      `options` provided in arguments. If map is unable to fit, method will warn and return undefined.
     * @example
     * var bbox = [[-79, 43], [-73, 45]];
     * var newCameraTransform = map.cameraForBounds(bbox, {
     *   padding: {top: 10, bottom:25, left: 15, right: 5}
     * });
     */
    cameraForBounds(bounds: LngLatBoundsLike, options?: CameraOptions): void | CameraOptions & AnimationOptions {
        options = extend({
            padding: {
                top: 0,
                bottom: 0,
                right: 0,
                left: 0
            },
            offset: [0, 0],
            maxZoom: this.transform.maxZoom
        }, options);

        if (typeof options.padding === 'number') {
            const p = options.padding;
            options.padding = {
                top: p,
                bottom: p,
                right: p,
                left: p
            };
        }
        if (!deepEqual(Object.keys(options.padding).sort((a, b) => {
            if (a < b) return -1;
            if (a > b) return 1;
            return 0;
        }), ["bottom", "left", "right", "top"])) {
            warnOnce(
                "options.padding must be a positive number, or an Object with keys 'bottom', 'left', 'right', 'top'"
            );
            return;
        }

        bounds = LngLatBounds.convert(bounds);

        // we separate the passed padding option into two parts, the part that does not affect the map's center
        // (lateral and vertical padding), and the part that does (paddingOffset). We add the padding offset
        // to the options `offset` object where it can alter the map's center in the subsequent calls to
        // `easeTo` and `flyTo`.
        const paddingOffset = [(options.padding.left - options.padding.right) / 2, (options.padding.top - options.padding.bottom) / 2],
            lateralPadding = Math.min(options.padding.right, options.padding.left),
            verticalPadding = Math.min(options.padding.top, options.padding.bottom);
        options.offset = [options.offset[0] + paddingOffset[0], options.offset[1] + paddingOffset[1]];

        const offset = Point.convert(options.offset),
            tr = this.transform,
            nw = tr.project(bounds.getNorthWest()),
            se = tr.project(bounds.getSouthEast()),
            size = se.sub(nw),
            scaleX = (tr.width - lateralPadding * 2 - Math.abs(offset.x) * 2) / size.x,
            scaleY = (tr.height - verticalPadding * 2 - Math.abs(offset.y) * 2) / size.y;

        if (scaleY < 0 || scaleX < 0) {
            warnOnce(
                'Map cannot fit within canvas with the given bounds, padding, and/or offset.'
            );
            return;
        }

        options.center = tr.unproject(nw.add(se).div(2));
        options.zoom = Math.min(tr.scaleZoom(tr.scale * Math.min(scaleX, scaleY)), options.maxZoom);
        options.bearing = 0;

        return options;
    }

    /**
     * Pans and zooms the map to contain its visible area within the specified geographical bounds.
     * This function will also reset the map's bearing to 0 if bearing is nonzero.
     *
     * @memberof Map#
     * @param bounds Center these bounds in the viewport and use the highest
     *      zoom level up to and including `Map#getMaxZoom()` that fits them in the viewport.
     * @param options
     * @param {number | PaddingOptions} [options.padding] The amount of padding in pixels to add to the given bounds.
     * @param {boolean} [options.linear=false] If `true`, the map transitions using
     *     {@link Map#easeTo}. If `false`, the map transitions using {@link Map#flyTo}. See
     *     those functions and {@link AnimationOptions} for information about options available.
     * @param {Function} [options.easing] An easing function for the animated transition. See {@link AnimationOptions}.
     * @param {PointLike} [options.offset=[0, 0]] The center of the given bounds relative to the map's center, measured in pixels.
     * @param {number} [options.maxZoom] The maximum zoom level to allow when the map view transitions to the specified bounds.
     * @param eventData Additional properties to be added to event objects of events triggered by this method.
     * @fires movestart
     * @fires moveend
     * @returns {Map} `this`
	 * @example
     * var bbox = [[-79, 43], [-73, 45]];
     * map.fitBounds(bbox, {
     *   padding: {top: 10, bottom:25, left: 15, right: 5}
     * });
     * @see [Fit a map to a bounding box](https://www.mapbox.com/mapbox-gl-js/example/fitbounds/)
     */
    fitBounds(bounds: LngLatBoundsLike, options?: AnimationOptions & CameraOptions, eventData?: Object) {
        const calculatedOptions = this.cameraForBounds(bounds, options);

        // cameraForBounds warns + returns undefined if unable to fit:
        if (!calculatedOptions) return this;

        options = extend(calculatedOptions, options);

        return options.linear ?
            this.easeTo(options, eventData) :
            this.flyTo(options, eventData);
    }

    /**
     * Changes any combination of center, zoom, bearing, and pitch, without
     * an animated transition. The map will retain its current values for any
     * details not specified in `options`.
     *
     * @memberof Map#
     * @param options
     * @param eventData Additional properties to be added to event objects of events triggered by this method.
     * @fires movestart
     * @fires zoomstart
     * @fires pitchstart
     * @fires rotate
     * @fires move
     * @fires zoom
     * @fires pitch
     * @fires moveend
     * @fires zoomend
     * @fires pitchend
     * @returns {Map} `this`
     */
    jumpTo(options: CameraOptions, eventData?: Object) {
        this.stop();

        const tr = this.transform;
        let zoomChanged = false,
            bearingChanged = false,
            pitchChanged = false;

        if ('zoom' in options && tr.zoom !== +options.zoom) {
            zoomChanged = true;
            tr.zoom = +options.zoom;
        }

        if (options.center !== undefined) {
            tr.center = LngLat.convert(options.center);
        }

        if ('bearing' in options && tr.bearing !== +options.bearing) {
            bearingChanged = true;
            tr.bearing = +options.bearing;
        }

        if ('pitch' in options && tr.pitch !== +options.pitch) {
            pitchChanged = true;
            tr.pitch = +options.pitch;
        }

        this.fire(new Event('movestart', eventData))
            .fire(new Event('move', eventData));

        if (zoomChanged) {
            this.fire(new Event('zoomstart', eventData))
                .fire(new Event('zoom', eventData))
                .fire(new Event('zoomend', eventData));
        }

        if (bearingChanged) {
            this.fire(new Event('rotatestart', eventData))
                .fire(new Event('rotate', eventData))
                .fire(new Event('rotateend', eventData));
        }

        if (pitchChanged) {
            this.fire(new Event('pitchstart', eventData))
                .fire(new Event('pitch', eventData))
                .fire(new Event('pitchend', eventData));
        }

        return this.fire(new Event('moveend', eventData));
    }

    /**
     * Changes any combination of center, zoom, bearing, and pitch, with an animated transition
     * between old and new values. The map will retain its current values for any
     * details not specified in `options`.
     *
     * @memberof Map#
     * @param options Options describing the destination and animation of the transition.
     *            Accepts {@link CameraOptions} and {@link AnimationOptions}.
     * @param eventData Additional properties to be added to event objects of events triggered by this method.
     * @fires movestart
     * @fires zoomstart
     * @fires pitchstart
     * @fires rotate
     * @fires move
     * @fires zoom
     * @fires pitch
     * @fires moveend
     * @fires zoomend
     * @fires pitchend
     * @returns {Map} `this`
     * @see [Navigate the map with game-like controls](https://www.mapbox.com/mapbox-gl-js/example/game-controls/)
     */
    easeTo(options: CameraOptions & AnimationOptions & {delayEndEvents?: number}, eventData?: Object) {
        this.stop();

        options = extend({
            offset: [0, 0],
            duration: 500,
            easing: defaultEasing
        }, options);

        if (options.animate === false) options.duration = 0;

        const tr = this.transform,
            startZoom = this.getZoom(),
            startBearing = this.getBearing(),
            startPitch = this.getPitch(),

            zoom = 'zoom' in options ? +options.zoom : startZoom,
            bearing = 'bearing' in options ? this._normalizeBearing(options.bearing, startBearing) : startBearing,
            pitch = 'pitch' in options ? +options.pitch : startPitch;

        const pointAtOffset = tr.centerPoint.add(Point.convert(options.offset));
        const locationAtOffset = tr.pointLocation(pointAtOffset);
        const center = LngLat.convert(options.center || locationAtOffset);
        this._normalizeCenter(center);

        const from = tr.project(locationAtOffset);
        const delta = tr.project(center).sub(from);
        const finalScale = tr.zoomScale(zoom - startZoom);

        let around, aroundPoint;

        if (options.around) {
            around = LngLat.convert(options.around);
            aroundPoint = tr.locationPoint(around);
        }

        this._zooming = (zoom !== startZoom);
        this._rotating = (startBearing !== bearing);
        this._pitching = (pitch !== startPitch);

        this._prepareEase(eventData, options.noMoveStart);

        clearTimeout(this._easeEndTimeoutID);

        this._ease((k) => {
            if (this._zooming) {
                tr.zoom = interpolate(startZoom, zoom, k);
            }
            if (this._rotating) {
                tr.bearing = interpolate(startBearing, bearing, k);
            }
            if (this._pitching) {
                tr.pitch = interpolate(startPitch, pitch, k);
            }

            if (around) {
                tr.setLocationAtPoint(around, aroundPoint);
            } else {
                const scale = tr.zoomScale(tr.zoom - startZoom);
                const base = zoom > startZoom ?
                    Math.min(2, finalScale) :
                    Math.max(0.5, finalScale);
                const speedup = Math.pow(base, 1 - k);
                const newCenter = tr.unproject(from.add(delta.mult(k * speedup)).mult(scale));
                tr.setLocationAtPoint(tr.renderWorldCopies ? newCenter.wrap() : newCenter, pointAtOffset);
            }

            this._fireMoveEvents(eventData);

        }, () => {
            if (options.delayEndEvents) {
                this._easeEndTimeoutID = setTimeout(() => this._afterEase(eventData), options.delayEndEvents);
            } else {
                this._afterEase(eventData);
            }
        }, options);

        return this;
    }

    _prepareEase(eventData?: Object, noMoveStart: boolean) {
        this._moving = true;

        if (!noMoveStart) {
            this.fire(new Event('movestart', eventData));
        }
        if (this._zooming) {
            this.fire(new Event('zoomstart', eventData));
        }
        if (this._rotating) {
            this.fire(new Event('rotatestart', eventData));
        }
        if (this._pitching) {
            this.fire(new Event('pitchstart', eventData));
        }
    }

    _fireMoveEvents(eventData?: Object) {
        this.fire(new Event('move', eventData));
        if (this._zooming) {
            this.fire(new Event('zoom', eventData));
        }
        if (this._rotating) {
            this.fire(new Event('rotate', eventData));
        }
        if (this._pitching) {
            this.fire(new Event('pitch', eventData));
        }
    }

    _afterEase(eventData?: Object) {
        const wasZooming = this._zooming;
        const wasRotating = this._rotating;
        const wasPitching = this._pitching;
        this._moving = false;
        this._zooming = false;
        this._rotating = false;
        this._pitching = false;

        if (wasZooming) {
            this.fire(new Event('zoomend', eventData));
        }
        if (wasRotating) {
            this.fire(new Event('rotateend', eventData));
        }
        if (wasPitching) {
            this.fire(new Event('pitchend', eventData));
        }
        this.fire(new Event('moveend', eventData));
    }

    /**
     * Changes any combination of center, zoom, bearing, and pitch, animating the transition along a curve that
     * evokes flight. The animation seamlessly incorporates zooming and panning to help
     * the user maintain her bearings even after traversing a great distance.
     *
     * @memberof Map#
     * @param {Object} options Options describing the destination and animation of the transition.
     *     Accepts {@link CameraOptions}, {@link AnimationOptions},
     *     and the following additional options.
     * @param {number} [options.curve=1.42] The zooming "curve" that will occur along the
     *     flight path. A high value maximizes zooming for an exaggerated animation, while a low
     *     value minimizes zooming for an effect closer to {@link Map#easeTo}. 1.42 is the average
     *     value selected by participants in the user study discussed in
     *     [van Wijk (2003)](https://www.win.tue.nl/~vanwijk/zoompan.pdf). A value of
     *     `Math.pow(6, 0.25)` would be equivalent to the root mean squared average velocity. A
     *     value of 1 would produce a circular motion.
     * @param {number} [options.minZoom] The zero-based zoom level at the peak of the flight path. If
     *     `options.curve` is specified, this option is ignored.
     * @param {number} [options.speed=1.2] The average speed of the animation defined in relation to
     *     `options.curve`. A speed of 1.2 means that the map appears to move along the flight path
     *     by 1.2 times `options.curve` screenfuls every second. A _screenful_ is the map's visible span.
     *     It does not correspond to a fixed physical distance, but varies by zoom level.
     * @param {number} [options.screenSpeed] The average speed of the animation measured in screenfuls
     *     per second, assuming a linear timing curve. If `options.speed` is specified, this option is ignored.
     * @param {number} [options.maxDuration] The animation's maximum duration, measured in milliseconds.
     *     If duration exceeds maximum duration, it resets to 0.
     * @param eventData Additional properties to be added to event objects of events triggered by this method.
     * @fires movestart
     * @fires zoomstart
     * @fires pitchstart
     * @fires move
     * @fires zoom
     * @fires rotate
     * @fires pitch
     * @fires moveend
     * @fires zoomend
     * @fires pitchend
     * @returns {Map} `this`
     * @example
     * // fly with default options to null island
     * map.flyTo({center: [0, 0], zoom: 9});
     * // using flyTo options
     * map.flyTo({
     *   center: [0, 0],
     *   zoom: 9,
     *   speed: 0.2,
     *   curve: 1,
     *   easing(t) {
     *     return t;
     *   }
     * });
     * @see [Fly to a location](https://www.mapbox.com/mapbox-gl-js/example/flyto/)
     * @see [Slowly fly to a location](https://www.mapbox.com/mapbox-gl-js/example/flyto-options/)
     * @see [Fly to a location based on scroll position](https://www.mapbox.com/mapbox-gl-js/example/scroll-fly-to/)
     */
    flyTo(options: Object, eventData?: Object) {
        // This method implements an “optimal path” animation, as detailed in:
        //
        // Van Wijk, Jarke J.; Nuij, Wim A. A. “Smooth and efficient zooming and panning.” INFOVIS
        //   ’03. pp. 15–22. <https://www.win.tue.nl/~vanwijk/zoompan.pdf#page=5>.
        //
        // Where applicable, local variable documentation begins with the associated variable or
        // function in van Wijk (2003).

        this.stop();

        options = extend({
            offset: [0, 0],
            speed: 1.2,
            curve: 1.42,
            easing: defaultEasing
        }, options);

        const tr = this.transform,
            startZoom = this.getZoom(),
            startBearing = this.getBearing(),
            startPitch = this.getPitch();

        const zoom = 'zoom' in options ? clamp(+options.zoom, tr.minZoom, tr.maxZoom) : startZoom;
        const bearing = 'bearing' in options ? this._normalizeBearing(options.bearing, startBearing) : startBearing;
        const pitch = 'pitch' in options ? +options.pitch : startPitch;

        const scale = tr.zoomScale(zoom - startZoom);
        const pointAtOffset = tr.centerPoint.add(Point.convert(options.offset));
        const locationAtOffset = tr.pointLocation(pointAtOffset);
        const center = LngLat.convert(options.center || locationAtOffset);
        this._normalizeCenter(center);

        const from = tr.project(locationAtOffset);
        const delta = tr.project(center).sub(from);

        let rho = options.curve;

        // w₀: Initial visible span, measured in pixels at the initial scale.
        const w0 = Math.max(tr.width, tr.height),
            // w₁: Final visible span, measured in pixels with respect to the initial scale.
            w1 = w0 / scale,
            // Length of the flight path as projected onto the ground plane, measured in pixels from
            // the world image origin at the initial scale.
            u1 = delta.mag();

        if ('minZoom' in options) {
            const minZoom = clamp(Math.min(options.minZoom, startZoom, zoom), tr.minZoom, tr.maxZoom);
            // w<sub>m</sub>: Maximum visible span, measured in pixels with respect to the initial
            // scale.
            const wMax = w0 / tr.zoomScale(minZoom - startZoom);
            rho = Math.sqrt(wMax / u1 * 2);
        }

        // ρ²
        const rho2 = rho * rho;

        /**
         * rᵢ: Returns the zoom-out factor at one end of the animation.
         *
         * @param i 0 for the ascent or 1 for the descent.
         * @private
         */
        function r(i) {
            const b = (w1 * w1 - w0 * w0 + (i ? -1 : 1) * rho2 * rho2 * u1 * u1) / (2 * (i ? w1 : w0) * rho2 * u1);
            return Math.log(Math.sqrt(b * b + 1) - b);
        }

        function sinh(n) { return (Math.exp(n) - Math.exp(-n)) / 2; }
        function cosh(n) { return (Math.exp(n) + Math.exp(-n)) / 2; }
        function tanh(n) { return sinh(n) / cosh(n); }

        // r₀: Zoom-out factor during ascent.
        const r0 = r(0);

        // w(s): Returns the visible span on the ground, measured in pixels with respect to the
        // initial scale. Assumes an angular field of view of 2 arctan ½ ≈ 53°.
        let w: (number) => number = function (s) {
            return (cosh(r0) / cosh(r0 + rho * s));
        };

        // u(s): Returns the distance along the flight path as projected onto the ground plane,
        // measured in pixels from the world image origin at the initial scale.
        let u: (number) => number = function (s) {
            return w0 * ((cosh(r0) * tanh(r0 + rho * s) - sinh(r0)) / rho2) / u1;
        };

        // S: Total length of the flight path, measured in ρ-screenfuls.
        let S = (r(1) - r0) / rho;

        // When u₀ = u₁, the optimal path doesn’t require both ascent and descent.
        if (Math.abs(u1) < 0.000001 || !isFinite(S)) {
            // Perform a more or less instantaneous transition if the path is too short.
            if (Math.abs(w0 - w1) < 0.000001) return this.easeTo(options, eventData);

            const k = w1 < w0 ? -1 : 1;
            S = Math.abs(Math.log(w1 / w0)) / rho;

            u = function() { return 0; };
            w = function(s) { return Math.exp(k * rho * s); };
        }

        if ('duration' in options) {
            options.duration = +options.duration;
        } else {
            const V = 'screenSpeed' in options ? +options.screenSpeed / rho : +options.speed;
            options.duration = 1000 * S / V;
        }

        if (options.maxDuration && options.duration > options.maxDuration) {
            options.duration = 0;
        }

        this._zooming = true;
        this._rotating = (startBearing !== bearing);
        this._pitching = (pitch !== startPitch);

        this._prepareEase(eventData, false);

        this._ease((k) => {
            // s: The distance traveled along the flight path, measured in ρ-screenfuls.
            const s = k * S;
            const scale = 1 / w(s);
            tr.zoom = k === 1 ? zoom : startZoom + tr.scaleZoom(scale);

            if (this._rotating) {
                tr.bearing = interpolate(startBearing, bearing, k);
            }
            if (this._pitching) {
                tr.pitch = interpolate(startPitch, pitch, k);
            }

            const newCenter = tr.unproject(from.add(delta.mult(u(s))).mult(scale));
            tr.setLocationAtPoint(tr.renderWorldCopies ? newCenter.wrap() : newCenter, pointAtOffset);

            this._fireMoveEvents(eventData);

        }, () => this._afterEase(eventData), options);

        return this;
    }

    isEasing() {
        return !!this._easeFrameId;
    }

    /**
     * Stops any animated transition underway.
     *
     * @memberof Map#
     * @returns {Map} `this`
     */
    stop(): this {
        if (this._easeFrameId) {
            this._cancelRenderFrame(this._easeFrameId);
            delete this._easeFrameId;
            delete this._onEaseFrame;
        }

        if (this._onEaseEnd) {
            // The _onEaseEnd function might emit events which trigger new
            // animation, which sets a new _onEaseEnd. Ensure we don't delete
            // it unintentionally.
            const onEaseEnd = this._onEaseEnd;
            delete this._onEaseEnd;
            onEaseEnd.call(this);
        }
        return this;
    }

    _ease(frame: (number) => void,
          finish: () => void,
          options: {animate: boolean, duration: number, easing: (number) => number}) {
        if (options.animate === false || options.duration === 0) {
            frame(1);
            finish();
        } else {
            this._easeStart = browser.now();
            this._easeOptions = options;
            this._onEaseFrame = frame;
            this._onEaseEnd = finish;
            this._easeFrameId = this._requestRenderFrame(this._renderFrameCallback);
        }
    }

    // Callback for map._requestRenderFrame
    _renderFrameCallback() {
        const t = Math.min((browser.now() - this._easeStart) / this._easeOptions.duration, 1);
        this._onEaseFrame(this._easeOptions.easing(t));
        if (t < 1) {
            this._easeFrameId = this._requestRenderFrame(this._renderFrameCallback);
        } else {
            this.stop();
        }
    }

    // convert bearing so that it's numerically close to the current one so that it interpolates properly
    _normalizeBearing(bearing: number, currentBearing: number) {
        bearing = wrap(bearing, -180, 180);
        const diff = Math.abs(bearing - currentBearing);
        if (Math.abs(bearing - 360 - currentBearing) < diff) bearing -= 360;
        if (Math.abs(bearing + 360 - currentBearing) < diff) bearing += 360;
        return bearing;
    }

    // If a path crossing the antimeridian would be shorter, extend the final coordinate so that
    // interpolating between the two endpoints will cross it.
    _normalizeCenter(center: LngLat) {
        const tr = this.transform;
        if (!tr.renderWorldCopies || tr.lngRange) return;

        const delta = center.lng - tr.center.lng;
        center.lng +=
            delta > 180 ? -360 :
            delta < -180 ? 360 : 0;
    }
}

export default Camera;
