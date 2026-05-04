export interface CoordinateReference {
  anchorPoint: "topLeft" | "topCenter" | "topRight" | "centerLeft" | "center" | "centerRight" | "bottomLeft" | "bottomCenter" | "bottomRight";
  offsetX: number;
  offsetY: number;
  parentReference?: string;
}

export interface UIScalingConfig {
  referenceWidth: number;
  referenceHeight: number;
  scaleMode: "exact" | "proportional" | "responsive";
  coordinateReference: CoordinateReference;
}

export interface UIPosition {
  type: "absolute" | "relative" | "centered";
  x: number;
  y: number;
  relativeTo?: string;
}

export interface UISize {
  type: "absolute" | "scale" | "auto";
  width?: number | string;
  height?: number | string;
  scaleX?: number;
  scaleY?: number;
}

export interface UILayoutConfig {
  layoutType: "Vertical" | "Horizontal" | "Grid" | "Table" | "None";
  padding: number;
  spacing: number;
  gridColumns?: number;
  fillDirection?: "Vertical" | "Horizontal";
}

export interface UIStroke {
  color: string;
  thickness: number;
  joins?: "Round" | "Miter" | "Bevel";
}

export interface UICorner {
  radius: number;
}

export interface UIColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export interface UIGradient {
  colors: UIColor[];
  rotation: number;
  transparency?: number[];
}

export interface UITextStyle {
  font: string;
  textSize: number;
  textColor: UIColor;
  textScaled?: boolean;
  textXAlignment?: "Left" | "Center" | "Right";
  textYAlignment?: "Top" | "Center" | "Bottom";
  richText?: boolean;
  lineHeight?: number;
}

export interface UIAnimation {
  type: "tween" | "sequence";
  easingStyle: "Linear" | "Quad" | "Cubic" | "Quart" | "Quint" | "Sine" | "Expo" | "Circ" | "Back" | "Bounce" | "Elastic";
  easingDirection: "In" | "Out" | "InOut";
  duration: number;
  property: string;
  startValue: number | string | UIColor;
  endValue: number | string | UIColor;
  delay?: number;
  repeatCount?: number;
  autoreverse?: boolean;
}

export interface UIElements {
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
  backgroundColor?: UIColor;
  backgroundTransparency?: number;
  backgroundGradient?: UIGradient;
  borderColor?: UIColor;
  borderThickness?: number;
  corner?: UICorner;
  stroke?: UIStroke;
  clipping?: boolean;
  automaticCanvasSize?: "X" | "Y" | "XY";
  canvasSizeX?: number;
  canvasSizeY?: number;
  content?: {
    text?: string;
    imageId?: string;
    imageRectMin?: { x: number; y: number };
    imageRectMax?: { x: number; y: number };
    sliceCenter?: { x: number; y: number; z: number; w: number };
  };
  textStyle?: UITextStyle;
  buttonConfig?: {
    hoverColor?: UIColor;
    clickColor?: UIColor;
    disabledColor?: UIColor;
    hoverTextColor?: UIColor;
    clickTextColor?: UIColor;
  };
  animations?: UIAnimation[];
  responsiveConfig?: {
    minWidth?: number;
    minHeight?: number;
    maxWidth?: number;
    maxHeight?: number;
    preferredAspectRatio?: number;
    resizeOnParentChange?: boolean;
  };
}

export interface UIContainer {
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
  elements: (UIElements | UIContainer)[];
}

export interface UIGenerationRequest {
  uiContainer: UIContainer;
  scalingConfig: UIScalingConfig;
  metadata?: {
    sourceImageUrl?: string;
    parserVersion?: string;
    generationTimestamp?: number;
  };
}

export interface UIGenerationResult {
  success: boolean;
  rootInstancePath: string;
  createdInstances: Array<{
    id: string;
    instancePath: string;
    className: string;
  }>;
  errors?: string[];
  warnings?: string[];
}

export interface UIPreviewData {
  containerJson: string;
  elementCount: number;
  estimatedComplexity: "simple" | "medium" | "complex";
  animationsCount: number;
}

export function createDefaultScalingConfig(): UIScalingConfig {
  return {
    referenceWidth: 1920,
    referenceHeight: 1080,
    scaleMode: "proportional",
    coordinateReference: {
      anchorPoint: "topLeft",
      offsetX: 0,
      offsetY: 0,
    },
  };
}

export function createDefaultUITextStyle(): UITextStyle {
  return {
    font: "GothamMedium",
    textSize: 14,
    textColor: { r: 255, g: 255, b: 255 },
    textXAlignment: "Center",
    textYAlignment: "Center",
  };
}

export function createBaseFrameConfig(id: string, name: string, parentId?: string): Partial<UIElements> {
  return {
    type: "Frame",
    id,
    name,
    parentId,
    visible: true,
    zIndex: 1,
    backgroundColor: { r: 30, g: 30, b: 30 },
    corner: { radius: 8 },
    stroke: { color: "#FFFFFF", thickness: 1, joins: "Round" },
  };
}