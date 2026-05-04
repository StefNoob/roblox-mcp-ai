import TweenService from "../../../devmodules/tween-service";
import Utils from "../Utils";

const { getInstancePath, getInstanceByPath } = Utils;

interface ColorRGB {
	r: number;
	g: number;
	b: number;
	a?: number;
}

interface UIPosition {
	type: "absolute" | "relative" | "centered";
	x: number;
	y: number;
	relativeTo?: string;
}

interface UISize {
	type: "absolute" | "scale" | "auto";
	width: number | string;
	height: number | string;
	scaleX?: number;
	scaleY?: number;
}

interface UILayoutConfig {
	layoutType: "Vertical" | "Horizontal" | "Grid" | "Table" | "None";
	padding: number;
	spacing: number;
	gridColumns?: number;
	fillDirection?: "Vertical" | "Horizontal";
}

interface UIStroke {
	color: string;
	thickness: number;
	joins?: "Round" | "Miter" | "Bevel";
}

interface UICorner {
	radius: number;
}

interface UITextStyle {
	font: string;
	textSize: number;
	textColor: ColorRGB;
	textScaled?: boolean;
	textXAlignment?: "Left" | "Center" | "Right";
	textYAlignment?: "Top" | "Center" | "Bottom";
	richText?: boolean;
	lineHeight?: number;
}

interface UIAnimation {
	type: "tween" | "sequence";
	easingStyle: "Linear" | "Quad" | "Cubic" | "Quart" | "Quint" | "Sine" | "Expo" | "Circ" | "Back" | "Bounce" | "Elastic";
	easingDirection: "In" | "Out" | "InOut";
	duration: number;
	property: string;
	startValue: number | string | ColorRGB;
	endValue: number | string | ColorRGB;
	delay?: number;
	repeatCount?: number;
	autoreverse?: boolean;
}

interface UIContent {
	text?: string;
	imageId?: string;
	imageRectMin?: { x: number; y: number };
	imageRectMax?: { x: number; y: number };
	sliceCenter?: { x: number; y: number; z: number; w: number };
}

interface ButtonConfig {
	hoverColor?: ColorRGB;
	clickColor?: ColorRGB;
	disabledColor?: ColorRGB;
	hoverTextColor?: ColorRGB;
	clickTextColor?: ColorRGB;
}

interface ResponsiveConfig {
	minWidth?: number;
	minHeight?: number;
	maxWidth?: number;
	maxHeight?: number;
	preferredAspectRatio?: number;
	resizeOnParentChange?: boolean;
}

interface UIScalingConfig {
	referenceWidth: number;
	referenceHeight: number;
	scaleMode: "exact" | "proportional" | "responsive";
	coordinateReference: {
		anchorPoint: "topLeft" | "topCenter" | "topRight" | "centerLeft" | "center" | "centerRight" | "bottomLeft" | "bottomCenter" | "bottomRight";
		offsetX: number;
		offsetY: number;
		parentReference?: string;
	};
}

interface UIElement {
	type: "Frame" | "TextLabel" | "TextButton" | "ImageLabel" | "ImageButton" | "ScrollingFrame" | "ViewportFrame";
	id: string;
	name: string;
	position?: UIPosition;
	size: UISize;
	parentId?: string;
	visible?: boolean;
	className?: string;
	zIndex?: number;
	layoutConfig?: UILayoutConfig;
	backgroundColor?: ColorRGB;
	backgroundTransparency?: number;
	borderColor?: ColorRGB;
	borderThickness?: number;
	corner?: UICorner;
	stroke?: UIStroke;
	clipping?: boolean;
	automaticCanvasSize?: "X" | "Y" | "XY";
	canvasSizeX?: number;
	canvasSizeY?: number;
	content?: UIContent;
	textStyle?: UITextStyle;
	buttonConfig?: ButtonConfig;
	animations?: UIAnimation[];
	responsiveConfig?: ResponsiveConfig;
}

interface UIContainer {
	id: string;
	type: "ScreenGui" | "BillboardGui" | "SurfaceGui" | "Frame" | "ScrollingFrame";
	name: string;
	parentPath?: string;
	position?: UIPosition;
	size?: UISize;
	resetOnSpawn?: boolean;
	ignoreGuiInset?: boolean;
	displayOrder?: number;
	enabled?: boolean;
	elements: (UIElement | UIContainer)[];
}

interface UIGenerationRequest {
	uiContainer: UIContainer;
	scalingConfig: UIScalingConfig;
	metadata?: {
		sourceImageUrl?: string;
		parserVersion?: string;
		generationTimestamp?: number;
	};
}

type CreatedInstance = {
	id: string;
	instancePath: string;
	className: string;
};

const ChangeHistoryService = game.GetService("ChangeHistoryService");

function colorToColor3(color: ColorRGB): Color3 {
	return Color3.fromRGB(color.r, color.g, color.b);
}

function hexToColor3(hex: string): Color3 {
	const cleanHex = hex.gsub("#", "")[0];
	const r = tonumber(cleanHex.sub(1, 2), 16) / 255;
	const g = tonumber(cleanHex.sub(3, 4), 16) / 255;
	const b = tonumber(cleanHex.sub(5, 6), 16) / 255;
	return new Color3(r, g, b);
}

function parseColor(value: ColorRGB | string | undefined): Color3 | undefined {
	if (!value) return undefined;
	if (typeof value === "string") {
		return hexToColor3(value);
	}
	return colorToColor3(value);
}

function getEasingStyle(style: string): Enum.EasingStyle {
	const styleMap: Record<string, Enum.EasingStyle> = {
		Linear: Enum.EasingStyle.Linear,
		Quad: Enum.EasingStyle.Quad,
		Cubic: Enum.EasingStyle.Cubic,
		Quart: Enum.EasingStyle.Quart,
		Quint: Enum.EasingStyle.Quint,
		Sine: Enum.EasingStyle.Sine,
		Expo: Enum.EasingStyle.Expo,
		Circ: Enum.EasingStyle.Circ,
		Back: Enum.EasingStyle.Back,
		Bounce: Enum.EasingStyle.Bounce,
		Elastic: Enum.EasingStyle.Elastic,
	};
	return styleMap[style] ?? Enum.EasingStyle.Quad;
}

function getEasingDirection(direction: string): Enum.EasingDirection {
	const directionMap: Record<string, Enum.EasingDirection> = {
		In: Enum.EasingDirection.In,
		Out: Enum.EasingDirection.Out,
		InOut: Enum.EasingDirection.InOut,
	};
	return directionMap[direction] ?? Enum.EasingDirection.Out;
}

function parseFont(fontName: string): Enum.Font {
	const fontMap: Record<string, Enum.Font> = {
		GothamMedium: Enum.Font.GothamMedium,
		GothamBold: Enum.Font.GothamBold,
		GothamSemibold: Enum.Font.GothamSemibold,
		Roboto: Enum.Font.Roboto,
		RobotoMono: Enum.Font.RobotoMono,
		SourceSans: Enum.Font.SourceSans,
	};
	return fontMap[fontName] ?? Enum.Font.GothamMedium;
}

function parseTextXAlignment(align: string): Enum.TextXAlignment {
	if (align === "Left") return Enum.TextXAlignment.Left;
	if (align === "Right") return Enum.TextXAlignment.Right;
	return Enum.TextXAlignment.Center;
}

function parseTextYAlignment(align: string): Enum.TextYAlignment {
	if (align === "Top") return Enum.TextYAlignment.Top;
	if (align === "Bottom") return Enum.TextYAlignment.Bottom;
	return Enum.TextYAlignment.Center;
}

function positionToUDim2(pos: UIPosition, refSize: UDim2): UDim2 {
	if (pos.type === "centered") {
		return new UDim2(0.5, pos.x - refSize.X.Offset / 2, 0.5, pos.y - refSize.Y.Offset / 2);
	}
	if (pos.type === "relative" && pos.relativeTo) {
		return new UDim2(0, pos.x, 0, pos.y);
	}
	return new UDim2(0, pos.x, 0, pos.y);
}

function sizeToUDim2(size: UISize): UDim2 {
	if (size.type === "scale") {
		return new UDim2(size.scaleX ?? 0, size.width as number, size.scaleY ?? 0, size.height as number);
	}
	if (size.type === "auto") {
		return new UDim2(0, 0, 0, 0);
	}
	return new UDim2(0, size.width as number, 0, size.height as number);
}

function applyPosition(element: Frame | TextLabel | TextButton | ImageLabel | ImageButton, pos: UIPosition | undefined, refSize: UDim2) {
	if (pos) {
		element.Position = positionToUDim2(pos, refSize);
	} else {
		element.Position = new UDim2(0, 0, 0, 0);
	}
}

function applySize(element: Frame | TextLabel | TextButton | ImageLabel | ImageButton, size: UISize) {
	element.Size = sizeToUDim2(size);
}

function applyCorner(instance: Instance, cornerConfig: UICorner | undefined) {
	if (cornerConfig) {
		const corner = new Instance("UICorner");
		corner.CornerRadius = new UDim(0, cornerConfig.radius);
		corner.Parent = instance;
	}
}

function applyStroke(instance: Frame | TextButton, strokeConfig: UIStroke | undefined) {
	if (strokeConfig) {
		const stroke = new Instance("UIStroke");
		stroke.Thickness = strokeConfig.thickness;
		if (strokeConfig.joins === "Round") {
			stroke.JoinMode = Enum.StrokeJoinMode.Round;
		} else if (strokeConfig.joins === "Miter") {
			stroke.JoinMode = Enum.StrokeJoinMode.Miter;
		} else {
			stroke.JoinMode = Enum.StrokeJoinMode.Bevel;
		}
		if (typeof strokeConfig.color === "string") {
			stroke.Color = hexToColor3(strokeConfig.color);
		} else if (strokeConfig.color) {
			stroke.Color = colorToColor3(strokeConfig.color);
		}
		stroke.Parent = instance;
	}
}

function applyLayout(element: Frame, layoutConfig: UILayoutConfig | undefined) {
	if (!layoutConfig || layoutConfig.layoutType === "None") return;

	let layout: UIListLayout | UIGridLayout | UITableLayout;
	if (layoutConfig.layoutType === "Horizontal") {
		layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Horizontal;
		layout.Padding = new UDim(0, layoutConfig.spacing);
	} else if (layoutConfig.layoutType === "Vertical") {
		layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.Padding = new UDim(0, layoutConfig.spacing);
	} else if (layoutConfig.layoutType === "Grid") {
		layout = new Instance("UIGridLayout");
		layout.CellPadding = new UDim2(0, layoutConfig.spacing, 0, layoutConfig.spacing);
		if (layoutConfig.gridColumns) {
			layout.CellCount = new Vector2(layoutConfig.gridColumns, 0);
		}
	} else {
		return;
	}

	if (layoutConfig.padding) {
		layout.Padding = new UDim(0, layoutConfig.padding);
	}

	layout.Parent = element;
}

function applyTextStyle(label: TextLabel | TextButton, textStyle: UITextStyle | undefined) {
	if (!textStyle) return;

	label.Font = parseFont(textStyle.font);
	label.TextSize = textStyle.textSize;
	if (textStyle.textColor) {
		label.TextColor3 = colorToColor3(textStyle.textColor);
	}
	if (textStyle.textXAlignment) {
		label.TextXAlignment = parseTextXAlignment(textStyle.textXAlignment);
	}
	if (textStyle.textYAlignment) {
		label.TextYAlignment = parseTextYAlignment(textStyle.textYAlignment);
	}
	if (textStyle.textScaled) {
		label.TextScaled = true;
	}
}

function applyBackground(element: Frame, bgColor: ColorRGB | undefined, transparency: number | undefined) {
	if (bgColor) {
		element.BackgroundColor3 = colorToColor3(bgColor);
	}
	if (transparency !== undefined) {
		element.BackgroundTransparency = transparency;
	} else {
		element.BackgroundTransparency = 0;
	}
}

function applyClipping(frame: Frame, clipping: boolean | undefined) {
	if (clipping) {
		frame.ClipsDescendants = true;
	}
}

function applyAutomaticCanvasSize(scrollingFrame: ScrollingFrame, autoSize: string | undefined, canvasSizeX: number | undefined, canvasSizeY: number | undefined) {
	if (autoSize === "X") {
		scrollingFrame.AutomaticCanvasSize = Enum.AutomaticSize.X;
	} else if (autoSize === "Y") {
		scrollingFrame.AutomaticCanvasSize = Enum.AutomaticSize.Y;
	} else if (autoSize === "XY") {
		scrollingFrame.AutomaticCanvasSize = Enum.AutomaticSize.XY;
	}
	if (canvasSizeX !== undefined || canvasSizeY !== undefined) {
		const canvasSize = scrollingFrame.CanvasSize || new UDim2(0, 0, 0, 0);
		if (canvasSizeX !== undefined) {
			canvasSize.X = new UDim(0, canvasSizeX);
		}
		if (canvasSizeY !== undefined) {
			canvasSize.Y = new UDim(0, canvasSizeY);
		}
		scrollingFrame.CanvasSize = canvasSize;
	}
}

function createTween(
	instance: Instance,
	animation: UIAnimation
): Tween | undefined {
	const easingStyle = getEasingStyle(animation.easingStyle);
	const easingDirection = getEasingDirection(animation.easingDirection);
	const tweenInfo = new TweenInfo(
		animation.duration,
		easingStyle,
		easingDirection,
		animation.repeatCount ?? 0,
		animation.autoreverse ?? false,
		animation.delay ?? 0
	);

	let startValue: unknown;
	let endValue: unknown;

	if (animation.property === "BackgroundColor3" || animation.property === "TextColor3") {
		if (typeof animation.startValue === "object" && "r" in (animation.startValue as ColorRGB)) {
			startValue = colorToColor3(animation.startValue as ColorRGB);
		} else if (typeof animation.startValue === "string") {
			startValue = hexToColor3(animation.startValue);
		}
		if (typeof animation.endValue === "object" && "r" in (animation.endValue as ColorRGB)) {
			endValue = colorToColor3(animation.endValue as ColorRGB);
		} else if (typeof animation.endValue === "string") {
			endValue = hexToColor3(animation.endValue);
		}
	} else if (animation.property === "Size") {
		startValue = animation.startValue;
		endValue = animation.endValue;
	} else if (animation.property === "Position") {
		startValue = animation.startValue;
		endValue = animation.endValue;
	} else {
		startValue = animation.startValue;
		endValue = animation.endValue;
	}

	const tween = TweenService.Create(
		instance,
		tweenInfo,
		{ [animation.property]: endValue } as Record<string, unknown>
	);

	return tween;
}

function applyAnimations(instance: Frame | TextButton, animations: UIAnimation[] | undefined, buttonConfig: ButtonConfig | undefined) {
	if (!animations || animations.size() === 0) return;

	for (const anim of animations) {
		const tween = createTween(instance, anim);
		if (tween && anim.type === "tween") {
			if (anim.delay && anim.delay > 0) {
				task.delay(anim.delay, () => {
					tween.Play();
				});
			} else {
				tween.Play();
			}
		}
	}

	if (buttonConfig && (instance.IsA("TextButton") || instance.IsA("ImageButton"))) {
		const button = instance as TextButton;
		let originalBgColor = button.BackgroundColor3;
		let originalTextColor = button.TextColor3;

		button.MouseEnter.Connect(() => {
			if (buttonConfig.hoverColor) {
				const tweenInfo = new TweenInfo(0.15, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
				const tween = TweenService.Create(button, tweenInfo, {
					BackgroundColor3: colorToColor3(buttonConfig.hoverColor),
				} as Record<string, Color3>);
				tween.Play();
			}
		});

		button.MouseLeave.Connect(() => {
			const tweenInfo = new TweenInfo(0.15, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
			const tween = TweenService.Create(button, tweenInfo, {
				BackgroundColor3: originalBgColor,
			} as Record<string, Color3>);
			tween.Play();
		});

		button.MouseButton1Click.Connect(() => {
			if (buttonConfig.clickColor) {
				const tweenInfo = new TweenInfo(0.1, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
				const tween = TweenService.Create(button, tweenInfo, {
					BackgroundColor3: colorToColor3(buttonConfig.clickColor),
				} as Record<string, Color3>);
				tween.Play();
			}
		});
	}
}

function createUIElement(
	element: UIElement | UIContainer,
	parentInstance: Instance,
	parentMap: Map<string, Instance>,
	createdInstances: CreatedInstance[],
	scalingConfig: UIScalingConfig,
	zIndexBase: number
): Instance | undefined {
	const className = element.type;
	let instance: Instance;

	if (className === "ScreenGui") {
		instance = new Instance("ScreenGui");
	} else if (className === "BillboardGui") {
		instance = new Instance("BillboardGui");
	} else if (className === "SurfaceGui") {
		instance = new Instance("SurfaceGui");
	} else if (className === "ScrollingFrame") {
		instance = new Instance("ScrollingFrame");
	} else if (className === "TextButton") {
		instance = new Instance("TextButton");
	} else if (className === "TextLabel") {
		instance = new Instance("TextLabel");
	} else if (className === "ImageLabel") {
		instance = new Instance("ImageLabel");
	} else if (className === "ImageButton") {
		instance = new Instance("ImageButton");
	} else {
		instance = new Instance("Frame");
	}

	instance.Name = element.name;

	if (element.zIndex !== undefined) {
		instance.ZIndex = element.zIndex + zIndexBase;
	}

	const frame = instance as Frame;
	const refSize = new UDim2(0, scalingConfig.referenceWidth, 0, scalingConfig.referenceHeight);

	applyPosition(frame, element.position, refSize);
	applySize(frame, element.size);

	if (element.type === "Frame" || element.type === "ScrollingFrame") {
		applyBackground(frame, element.backgroundColor, element.backgroundTransparency);
		applyCorner(instance, element.corner);
		applyStroke(frame, element.stroke as UIStroke | undefined);
		applyLayout(frame, element.layoutConfig);
		applyClipping(frame, element.clipping);

		if (element.type === "ScrollingFrame" && element.automaticCanvasSize) {
			applyAutomaticCanvasSize(instance as ScrollingFrame, element.automaticCanvasSize, element.canvasSizeX, element.canvasSizeY);
		}
	}

	if ((element.type === "TextLabel" || element.type === "TextButton") && element.textStyle) {
		applyTextStyle(instance as TextLabel, element.textStyle);
	}

	if (element.content) {
		if (element.content.text !== undefined) {
			if (instance.IsA("TextLabel") || instance.IsA("TextButton")) {
				(instance as TextLabel).Text = element.content.text;
			}
		}
	}

	if (element.visible !== undefined) {
		instance.Visible = element.visible;
	} else {
		instance.Visible = true;
	}

	if (element.animations) {
		applyAnimations(frame, element.animations, element.buttonConfig);
	}

	const instancePath = getInstancePath(instance);
	createdInstances.push({
		id: element.id,
		instancePath,
		className: element.type,
	});
	parentMap.set(element.id, instance);

	if (element.elements) {
		for (const child of element.elements) {
			const childInstance = createUIElement(child, instance, parentMap, createdInstances, scalingConfig, zIndexBase);
			if (childInstance) {
				childInstance.Parent = instance;
			}
		}
	}

	instance.Parent = parentInstance;
	return instance;
}

export function generateUI(requestData: Record<string, unknown>) {
	const request = requestData as unknown as UIGenerationRequest;

	if (!request.uiContainer) {
		return { error: "uiContainer is required" };
	}

	if (!request.uiContainer.elements || !typeIs(request.uiContainer.elements, "table")) {
		return { error: "uiContainer.elements must be an array" };
	}

	const container = request.uiContainer;
	const scalingConfig = request.scalingConfig || {
		referenceWidth: 1920,
		referenceHeight: 1080,
		scaleMode: "proportional",
		coordinateReference: {
			anchorPoint: "topLeft",
			offsetX: 0,
			offsetY: 0,
		},
	};

	let parentInstance: Instance = game;
	if (container.parentPath) {
		const specifiedParent = getInstanceByPath(container.parentPath);
		if (specifiedParent) {
			parentInstance = specifiedParent;
		}
	}

	let rootGui: Instance;
	if (container.type === "ScreenGui") {
		rootGui = new Instance("ScreenGui");
		rootGui.Name = container.name;
		if (container.displayOrder !== undefined) {
			rootGui.DisplayOrder = container.displayOrder;
		}
		if (container.enabled !== undefined) {
			rootGui.Enabled = container.enabled;
		}
		if (container.resetOnSpawn !== undefined) {
			rootGui.ResetOnSpawn = container.resetOnSpawn;
		}
		if (container.ignoreGuiInset !== undefined) {
			rootGui.IgnoreGuiInset = container.ignoreGuiInset;
		}
	} else if (container.type === "BillboardGui") {
		rootGui = new Instance("BillboardGui");
		rootGui.Name = container.name;
	} else if (container.type === "SurfaceGui") {
		rootGui = new Instance("SurfaceGui");
		rootGui.Name = container.name;
	} else {
		rootGui = new Instance("Frame");
		rootGui.Name = container.name;
		if (container.position) {
			const refSize = new UDim2(0, scalingConfig.referenceWidth, 0, scalingConfig.referenceHeight);
			(rootGui as Frame).Position = positionToUDim2(container.position, refSize);
		}
		if (container.size) {
			(rootGui as Frame).Size = sizeToUDim2(container.size);
		}
	}

	const createdInstances: CreatedInstance[] = [];
	const parentMap = new Map<string, Instance>();

	parentMap.set(container.id, rootGui);

	const zIndexBase = container.zIndex ? container.zIndex * 100 : 0;

	const errors: string[] = [];
	const warnings: string[] = [];

	for (const element of container.elements) {
		try {
			const instance = createUIElement(
				element as UIElement,
				rootGui,
				parentMap,
				createdInstances,
				scalingConfig,
				zIndexBase
			);
			if (!instance) {
				warnings.push(`Failed to create element: ${(element as UIElement).id}`);
			}
		} catch (e) {
			const errorMsg = e instanceof Error ? e.message : tostring(e);
			errors.push(`Error creating element ${(element as UIElement).id}: ${errorMsg}`);
		}
	}

	rootGui.Parent = parentInstance;
	ChangeHistoryService.SetWaypoint("Generate UI from image parser");

	const rootInstancePath = getInstancePath(rootGui);

	return {
		success: errors.size() === 0,
		rootInstancePath,
		createdInstances,
		errors: errors.size() > 0 ? errors : undefined,
		warnings: warnings.size() > 0 ? warnings : undefined,
	};
}