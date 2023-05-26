import { Injectable } from '@nestjs/common';
import { v4 } from 'uuid';

import { User, UserRole } from '../../auth/entities/user.entity';
import { UserAppService } from '../../auth/services/user.app-service';
import { NotFoundError } from '../../lib/errors/not-found.error';
import { OrderStatus } from '../entities/order.entity';
import {
  Student,
  StudentStatus,
  StudentTestResult,
} from '../entities/student.entity';
import { AccessError } from '../errors/access.error';
import { NotAllowedError } from '../errors/not-allowed.error';
import { CourseRepository } from '../repositories/course.repository';
import { OrderRepository } from '../repositories/order.repository';
import { StudentRepository } from '../repositories/student.repository';
import { PaymentMethod } from '../types/payment-method';

import { CompanyFindByEmployeeUsecase } from './company-find-by-employee.usecase';
import { OrderCreateStudentDto } from './dto/order-create-student.dto';
import { OrderService } from './order.service';
import { StudentService } from './student.service';

@Injectable()
export class OrderCreateStudentUsecase {
  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly orderService: OrderService,
    private readonly studentRepo: StudentRepository,
    private readonly studentService: StudentService,
    private readonly courseRepo: CourseRepository,
    private readonly userAppService: UserAppService,
    private readonly companyFindByEmployeeUseCase: CompanyFindByEmployeeUsecase,
  ) {}

  async run(
    orderId: string,
    dto: OrderCreateStudentDto,
    user: User,
  ): Promise<Student> {
    if (!this.userAppService.isActiveCompany(user)) {
      throw new AccessError(`User not able to create student`);
    }

    if (!(await this.courseRepo.findPackById(dto.packId))) {
      throw new NotFoundError('There is no pack with provided id');
    }

    let order = await this.orderRepo.findAndLockById(orderId);
    if (!order) {
      throw new NotAllowedError(
        `Could not add student to order ${orderId}: order do not exists`,
      );
    }

    if (user.role === UserRole.company && order.companyId !== user.id) {
      await this.orderRepo.unlock(order);
      throw new AccessError(
        `Could not add student to order ${order.id}: it belongs to different company`,
      );
    }

    if (user.role === UserRole.employee) {
      const company = await this.companyFindByEmployeeUseCase.run(
        user.id,
        user,
      );
      if (order.companyId !== company.id) {
        await this.orderRepo.unlock(order);
        throw new AccessError(
          `Could not add student to order ${order.id}: it belongs to different company`,
        );
      }
    }

    if (order.status !== OrderStatus.pending) {
      await this.orderRepo.unlock(order);
      throw new NotAllowedError(
        `Could create student to order ${order.id}: order is not in pending state`,
      );
    }

    const course = await this.courseRepo.findById(order.courseId);
    if (!course) {
      throw new NotAllowedError(
        `Could not add student to order ${orderId}: related course does not exists`,
      );
    }

    if (order.paymentSessionId) {
      await this.orderService.expireOrderPaymentSession(order);
    }

    try {
      const student = new Student({
        id: v4(),
        courseId: order.courseId,
        courseDate: course.date,
        orderId: order.id,
        managerId: order.managerId,
        companyId: order.companyId,
        status: StudentStatus.pending,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
        email: dto.email || '',
        language: null,
        packId: dto.packId,
        certificateId: null,
        certificateFileId: null,
        testResult: StudentTestResult.pending,
        paymentMethod: PaymentMethod.startValue,
      });
      await this.studentRepo.save(student);

      const newStudentList = [...order.studentIds, student.id];
      await this.orderService.updateOrderStudents(order, newStudentList);
      order = await this.orderRepo.save(order);

      const bookedStudent = await this.studentService.findById(student.id);
      if (!bookedStudent) {
        throw new Error('Student was unexpectedly removed');
      }

      return bookedStudent;
    } finally {
      await this.orderRepo.unlock(order);
    }
  }
}
