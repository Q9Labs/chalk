#import "ChalkAnnotationPiPPaint.h"

static CGFloat Number(NSArray *values, NSUInteger index) {
  return [values[index] doubleValue];
}

static UIColor *InkColor(NSString *hex, CGFloat opacity) {
  NSString *digits = [hex substringFromIndex:1];
  unsigned value = 0;
  [[NSScanner scannerWithString:digits] scanHexInt:&value];
  if (digits.length == 3 || digits.length == 4) {
    opacity *= digits.length == 4 ? (value & 15) / 15.0 : 1;
    if (digits.length == 4) value >>= 4;
    return [UIColor colorWithRed:(value >> 8) / 15.0 green:((value >> 4) & 15) / 15.0 blue:(value & 15) / 15.0 alpha:opacity];
  }
  return [UIColor colorWithRed:(value >> 16) / 255.0 green:((value >> 8) & 255) / 255.0 blue:(value & 255) / 255.0 alpha:opacity];
}

static void AddPath(CGContextRef context, NSArray<NSArray *> *path) {
  CGContextBeginPath(context);
  for (NSArray *part in path) {
    NSString *kind = part[0];
    if ([kind isEqualToString:@"close"]) {
      CGContextClosePath(context);
    } else if ([kind isEqualToString:@"move"]) {
      CGContextMoveToPoint(context, Number(part, 1), Number(part, 2));
    } else if ([kind isEqualToString:@"line"]) {
      CGContextAddLineToPoint(context, Number(part, 1), Number(part, 2));
    } else if ([kind isEqualToString:@"arc"]) {
      CGContextAddArc(context, Number(part, 1), Number(part, 2), Number(part, 3), Number(part, 4), Number(part, 5), false);
    } else {
      CGRect rect = CGRectMake(Number(part, 1), Number(part, 2), Number(part, 3), Number(part, 4));
      if ([kind isEqualToString:@"ellipse"]) {
        CGContextAddEllipseInRect(context, rect);
      } else {
        CGContextAddRect(context, rect);
      }
    }
  }
}

void ChalkAnnotationPaintPiP(CGContextRef context, NSArray<NSArray *> *operations) {
  CGContextSetLineJoin(context, kCGLineJoinRound);
  UIGraphicsPushContext(context);
  for (NSArray *op in operations) {
    UIColor *color = InkColor(op[1], Number(op, 2));
    NSString *kind = op[0];
    if ([kind isEqualToString:@"text"]) {
      UIFont *font = [UIFont systemFontOfSize:Number(op, 6) weight:UIFontWeightSemibold];
      [op[3] drawAtPoint:CGPointMake(Number(op, 4), Number(op, 5) - font.lineHeight / 2)
          withAttributes:@{NSFontAttributeName: font, NSForegroundColorAttributeName: color}];
      continue;
    }
    AddPath(context, op[3]);
    if ([kind isEqualToString:@"stroke"]) {
      CGContextSetStrokeColorWithColor(context, color.CGColor);
      CGContextSetLineWidth(context, MAX(1, Number(op, 4)));
      CGContextSetLineCap(context, [op[5] isEqualToString:@"butt"] ? kCGLineCapButt : kCGLineCapRound);
      CGContextStrokePath(context);
    } else {
      CGContextSetFillColorWithColor(context, color.CGColor);
      CGContextFillPath(context);
    }
  }
  UIGraphicsPopContext();
}
